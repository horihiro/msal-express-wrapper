/*
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */
import express from "express";

import {
    RequestHandler,
    Request,
    Response,
    NextFunction,
    Router
} from "express";

import {
    InteractionRequiredAuthError,
    OIDC_DEFAULT_SCOPES,
    PromptValue,
    StringUtils,
} from "@azure/msal-common";

import {
    ConfidentialClientApplication,
    Configuration,
    AccountInfo,
    ICachePlugin,
    CryptoProvider,
    AuthorizationUrlRequest,
    AuthorizationCodeRequest,
    SilentFlowRequest,
    OnBehalfOfRequest,
} from "@azure/msal-node";

import { ConfigurationUtils } from "./ConfigurationUtils";
import { TokenValidator } from "./TokenValidator";
import { KeyVaultManager } from "./KeyVaultManager";
import { FetchManager } from "./FetchManager";
import { UrlUtils } from "./UrlUtils";
import { Logger } from "./Logger";

import {
    Resource,
    AppSettings,
    AuthCodeParams,
    InitializationOptions,
    TokenRequestOptions,
    GuardOptions,
    AccessRule,
    SignInOptions,
    SignOutOptions,
    HandleRedirectOptions
} from "./Types";

import {
    AppStages,
    ErrorMessages,
    AccessConstants,
    InfoMessages
} from "./Constants";

/**
 * A simple wrapper around MSAL Node ConfidentialClientApplication object.
 * It offers a collection of middleware and utility methods that automate
 * basic authentication and authorization tasks in Express MVC web apps and
 * RESTful APIs (coming soon).
 */
export class AuthProvider {
    appSettings: AppSettings;
    private msalConfig: Configuration;
    private cryptoProvider: CryptoProvider;
    private tokenValidator: TokenValidator;
    private msalClient: ConfidentialClientApplication;

    /**
     * @param {AppSettings} appSettings
     * @param {ICachePlugin} cache: cachePlugin
     * @constructor
     */
    constructor(appSettings: AppSettings, cache?: ICachePlugin) {
        ConfigurationUtils.validateAppSettings(appSettings);
        this.appSettings = appSettings;

        this.msalConfig = ConfigurationUtils.getMsalConfiguration(appSettings, cache);
        this.msalClient = new ConfidentialClientApplication(this.msalConfig);

        this.tokenValidator = new TokenValidator(this.appSettings, this.msalConfig);
        this.cryptoProvider = new CryptoProvider();
    }

    /**
     * Asynchronously builds authProvider object with credentials fetched from Key Vault
     * @param {AppSettings} appSettings
     * @param {ICachePlugin} cache: cachePlugin
     * @returns 
     */
    static async buildAsync(appSettings: AppSettings, cache?: ICachePlugin): Promise<AuthProvider> {
        try {
            const keyVault = new KeyVaultManager();
            const appSettingsWithKeyVaultCredentials = await keyVault.getCredentialFromKeyVault(appSettings);
            const authProvider = new AuthProvider(appSettingsWithKeyVaultCredentials, cache);
            return authProvider;
        } catch (error) {
            console.log(error);
        }
    }

    /**
     * Initialize AuthProvider and set default routes and handlers
     * @param {InitializationOptions} options
     * @returns {Router}
     */
    initialize = (options?: InitializationOptions): Router => {

        // TODO: initialize app defaults

        const appRouter = express.Router();

        // handle redirect
        appRouter.get(UrlUtils.getPathFromUrl(this.appSettings.authRoutes.redirect), this.handleRedirect());

        if (this.appSettings.authRoutes.frontChannelLogout) {
            /**
             * Expose front-channel logout route. For more information, visit: 
             * https://docs.microsoft.com/azure/active-directory/develop/v2-protocols-oidc#single-sign-out
             */
            appRouter.get(this.appSettings.authRoutes.frontChannelLogout, (req, res, next) => {
                req.session.destroy(() => {
                    res.sendStatus(200);
                });
            });
        }

        return appRouter;
    }

    // ========== ROUTE HANDLERS ===========

    /**
     * Initiates sign in flow
     * @param {SignInOptions} options: options to modify login request
     * @returns {RequestHandler}
     */
    signIn = (options?: SignInOptions): RequestHandler => {
        return (req: Request, res: Response, next: NextFunction): Promise<void> => {
            /**
             * Request Configuration
             * We manipulate these three request objects below
             * to acquire a token with the appropriate claims
             */
            if (!req.session["authCodeRequest"]) {
                req.session.authCodeRequest = {
                    authority: "",
                    scopes: [],
                    state: {},
                    redirectUri: "",
                } as AuthorizationUrlRequest;
            }

            if (!req.session["tokenRequest"]) {
                req.session.tokenRequest = {
                    authority: "",
                    scopes: [],
                    redirectUri: "",
                    code: "",
                } as AuthorizationCodeRequest;
            }

            // signed-in user's account
            if (!req.session["account"]) {
                req.session.account = {
                    homeAccountId: "",
                    environment: "",
                    tenantId: "",
                    username: "",
                    idTokenClaims: {},
                } as AccountInfo;
            }

            // random GUID for csrf protection
            req.session.nonce = this.cryptoProvider.createNewGuid();
            
            // TODO: encrypt state parameter 
            const state = this.cryptoProvider.base64Encode(
                JSON.stringify({
                    stage: AppStages.SIGN_IN,
                    path: options.successRedirect,
                    nonce: req.session.nonce,
                })
            );

            const params: AuthCodeParams = {
                authority: this.msalConfig.auth.authority,
                scopes: OIDC_DEFAULT_SCOPES,
                state: state,
                redirect: UrlUtils.ensureAbsoluteUrl(req, this.appSettings.authRoutes.redirect),
                prompt: PromptValue.SELECT_ACCOUNT,
            };

            // get url to sign user in
            return this.getAuthCode(req, res, next, params);
        }
    };

    /**
     * Initiate sign out and destroy the session
     * @param options: options to modify logout request 
     * @returns {RequestHandler}
     */
    signOut = (options?: SignOutOptions): RequestHandler => {
        return (req: Request, res: Response, next: NextFunction): void => {
            const postLogoutRedirectUri = UrlUtils.ensureAbsoluteUrl(req, options.successRedirect);

            /**
             * Construct a logout URI and redirect the user to end the
             * session with Azure AD/B2C. For more information, visit:
             * (AAD) https://docs.microsoft.com/azure/active-directory/develop/v2-protocols-oidc#send-a-sign-out-request
             * (B2C) https://docs.microsoft.com/azure/active-directory-b2c/openid-connect#send-a-sign-out-request
             */
            const logoutURI = `${this.msalConfig.auth.authority}/oauth2/v2.0/logout?post_logout_redirect_uri=${postLogoutRedirectUri}`;

            req.session.isAuthenticated = false;

            req.session.destroy(() => {
                res.redirect(logoutURI);
            });
        }
    };

    /**
     * Middleware that handles redirect depending on request state
     * There are basically 2 stages: sign-in and acquire token
     * @param {HandleRedirectOptions} options: options to modify this middleware
     * @returns {RequestHandler}
     */
    private handleRedirect = (options?: HandleRedirectOptions): RequestHandler => {
        return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
            if (req.query.state) {
                const state = JSON.parse(this.cryptoProvider.base64Decode(req.query.state as string));

                // check if nonce matches
                if (state.nonce === req.session.nonce) {
                    switch (state.stage) {
                        case AppStages.SIGN_IN: {
                            // token request should have auth code
                            req.session.tokenRequest.code = req.query.code as string;

                            try {
                                // exchange auth code for tokens
                                const tokenResponse = await this.msalClient.acquireTokenByCode(req.session.tokenRequest);

                                try {
                                    const isIdTokenValid = await this.tokenValidator.validateIdToken(tokenResponse.idToken);

                                    if (isIdTokenValid) {
                                        // assign session variables
                                        req.session.account = tokenResponse.account;
                                        req.session.isAuthenticated = true;

                                        res.redirect(state.path);
                                    } else {
                                        Logger.logError(ErrorMessages.INVALID_TOKEN);
                                        res.redirect(this.appSettings.authRoutes.unauthorized);
                                    }
                                } catch (error) {
                                    Logger.logError(ErrorMessages.CANNOT_VALIDATE_TOKEN);
                                    next(error)
                                }
                            } catch (error) {
                                Logger.logError(ErrorMessages.TOKEN_ACQUISITION_FAILED);
                                next(error)
                            }
                            break;
                        }

                        case AppStages.ACQUIRE_TOKEN: {
                            // get the name of the resource associated with scope
                            const resourceName = this.getResourceNameFromScopes(req.session.tokenRequest.scopes);

                            req.session.tokenRequest.code = req.query.code as string

                            try {
                                const tokenResponse = await this.msalClient.acquireTokenByCode(req.session.tokenRequest);
                                req.session.remoteResources[resourceName].accessToken = tokenResponse.accessToken;
                                res.redirect(state.path);
                            } catch (error) {
                                Logger.logError(ErrorMessages.TOKEN_ACQUISITION_FAILED);
                                next(error);
                            }
                            break;
                        }

                        default:
                            Logger.logError(ErrorMessages.CANNOT_DETERMINE_APP_STAGE);
                            res.redirect(this.appSettings.authRoutes.error);
                            break;
                    }
                } else {
                    Logger.logError(ErrorMessages.NONCE_MISMATCH);
                    res.redirect(this.appSettings.authRoutes.unauthorized);
                }
            } else {
                Logger.logError(ErrorMessages.STATE_NOT_FOUND)
                res.redirect(this.appSettings.authRoutes.unauthorized);
            }
        }
    };

    // ========== MIDDLEWARE ===========

    /**
     * Middleware that gets tokens via acquireToken*
     * @param {TokenRequestOptions} options: options to modify this middleware
     * @returns {RequestHandler}
     */
    getToken = (options: TokenRequestOptions): RequestHandler => {
        return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
            // get scopes for token request
            const scopes = options.resource.scopes;

            const resourceName = this.getResourceNameFromScopes(scopes)

            if (!req.session.remoteResources) {
                req.session.remoteResources = {};
            }

            req.session.remoteResources = {
                [resourceName]: {
                    ...this.appSettings.remoteResources[resourceName],
                    accessToken: null,
                } as Resource
            };

            try {
                const silentRequest: SilentFlowRequest = {
                    account: req.session.account,
                    scopes: scopes,
                };

                // acquire token silently to be used in resource call
                const tokenResponse = await this.msalClient.acquireTokenSilent(silentRequest);

                // In B2C scenarios, sometimes an access token is returned empty.
                // In that case, we will acquire token interactively instead.
                if (StringUtils.isEmpty(tokenResponse.accessToken)) {
                    Logger.logError(ErrorMessages.TOKEN_NOT_FOUND);
                    throw new InteractionRequiredAuthError(ErrorMessages.INTERACTION_REQUIRED);
                }

                req.session.remoteResources[resourceName].accessToken = tokenResponse.accessToken;
                next();
            } catch (error) {
                // in case there are no cached tokens, initiate an interactive call
                if (error instanceof InteractionRequiredAuthError) {
                    const state = this.cryptoProvider.base64Encode(
                        JSON.stringify({
                            stage: AppStages.ACQUIRE_TOKEN,
                            path: req.originalUrl,
                            nonce: req.session.nonce,
                        })
                    );

                    const params: AuthCodeParams = {
                        authority: this.msalConfig.auth.authority,
                        scopes: scopes,
                        state: state,
                        redirect: UrlUtils.ensureAbsoluteUrl(req, this.appSettings.authRoutes.redirect),
                        account: req.session.account,
                    };

                    // initiate the first leg of auth code grant to get token
                    return this.getAuthCode(req, res, next, params);
                } else {
                    next(error);
                }
            }
        }
    };

    /**
     * Middleware that gets tokens via OBO flow. Used in web API scenarios
     * @param {TokenRequestOptions} options: options to modify this middleware
     * @returns {RequestHandler}
     */
    getTokenOnBehalf = (options: TokenRequestOptions): RequestHandler => {
        return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
            const authHeader = req.headers.authorization;

            // get scopes for token request
            const scopes = options.resource.scopes;
            const resourceName = this.getResourceNameFromScopes(scopes);

            const oboRequest: OnBehalfOfRequest = {
                oboAssertion: authHeader.split(" ")[1],
                scopes: scopes,
            }

            try {
                const tokenResponse = await this.msalClient.acquireTokenOnBehalfOf(oboRequest);

                // as OBO is commonly used in middle-tier web APIs without sessions, attach AT to req
                req["locals"] = {
                    [resourceName]: {
                        accessToken: tokenResponse.accessToken
                    }
                }

                next();
            } catch (error) {
                next(error);
            }
        }
    }

    // ============== GUARDS ===============

    /**
     * Check if authenticated in session
     * @param {GuardOptions} options: options to modify this middleware
     * @returns {RequestHandler}
     */
    isAuthenticated = (options?: GuardOptions): RequestHandler => {
        return (req: Request, res: Response, next: NextFunction): void => {
            if (req.session) {
                if (!req.session.isAuthenticated) {
                    Logger.logError(ErrorMessages.NOT_PERMITTED);
                    return res.redirect(this.appSettings.authRoutes.unauthorized);
                }

                next();
            } else {
                Logger.logError(ErrorMessages.SESSION_NOT_FOUND);
                res.redirect(this.appSettings.authRoutes.unauthorized);
            }
        }
    };

    /**
     * Receives access token in req authorization header
     * and validates it using the jwt.verify
     * @param {GuardOptions} options: options to modify this middleware
     * @returns {RequestHandler}
     */
    isAuthorized = (options?: GuardOptions): RequestHandler => {
        return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
            const accessToken = req.headers.authorization.split(" ")[1];

            if (req.headers.authorization) {
                if (!(await this.tokenValidator.verifyAccessTokenSignature(accessToken, `${req.baseUrl}${req.path}`))) {
                    Logger.logError(ErrorMessages.INVALID_TOKEN);
                    return res.redirect(this.appSettings.authRoutes.unauthorized);
                }

                next();
            } else {
                Logger.logError(ErrorMessages.TOKEN_NOT_FOUND);
                res.redirect(this.appSettings.authRoutes.unauthorized);
            }
        }
    };

    /**
     * Checks if the user has access for this route, defined in access matrix
     * @param {GuardOptions} options: options to modify this middleware
     * @returns {RequestHandler}
     */
    hasAccess = (options?: GuardOptions): RequestHandler => {
        return async (req: Request, res: Response, next: NextFunction): Promise<any> => {
            if (req.session && this.appSettings.accessMatrix) {

                const checkFor = options.accessRule.hasOwnProperty(AccessConstants.GROUPS) ? AccessConstants.GROUPS : AccessConstants.ROLES;

                switch (checkFor) {
                    case AccessConstants.GROUPS:

                        if (req.session.account.idTokenClaims[AccessConstants.GROUPS] === undefined) {
                            if (req.session.account.idTokenClaims[AccessConstants.CLAIM_NAMES] || req.session.account.idTokenClaims[AccessConstants.CLAIM_SOURCES]) {
                                Logger.logWarning(InfoMessages.OVERAGE_OCCURRED)
                                return await this.handleOverage(req, res, next, options.accessRule);
                            } else {
                                Logger.logError(ErrorMessages.USER_HAS_NO_GROUP);
                                return res.redirect(this.appSettings.authRoutes.unauthorized);
                            }
                        } else {
                            const groups = req.session.account.idTokenClaims[AccessConstants.GROUPS];

                            if (!this.checkAccessRule(req.method, options.accessRule, groups, AccessConstants.GROUPS)) {
                                return res.redirect(this.appSettings.authRoutes.unauthorized);
                            }
                        }

                        next();
                        break;

                    case AccessConstants.ROLES:
                        if (req.session.account.idTokenClaims[AccessConstants.ROLES] === undefined) {
                            Logger.logError(ErrorMessages.USER_HAS_NO_ROLE);
                            return res.redirect(this.appSettings.authRoutes.unauthorized);
                        } else {
                            const roles = req.session.account.idTokenClaims[AccessConstants.ROLES];

                            if (!this.checkAccessRule(req.method, options.accessRule, roles, AccessConstants.ROLES)) {
                                return res.redirect(this.appSettings.authRoutes.unauthorized);
                            }
                        }

                        next();
                        break;

                    default:
                        break;
                }
            } else {
                res.redirect(this.appSettings.authRoutes.unauthorized);
            }
        }
    }

    // ============== UTILS ===============

    /**
     * This method is used to generate an auth code url request
     * @param {Request} req: express request object
     * @param {Response} res: express response object
     * @param {NextFunction} next: express next function
     * @param {AuthCodeParams} params: modifies auth code url request
     * @returns {Promise}
     */
    private async getAuthCode(req: Request, res: Response, next: NextFunction, params: AuthCodeParams): Promise<void> {
        // prepare the request
        req.session.authCodeRequest.authority = params.authority;
        req.session.authCodeRequest.scopes = params.scopes;
        req.session.authCodeRequest.state = params.state;
        req.session.authCodeRequest.redirectUri = params.redirect;
        req.session.authCodeRequest.prompt = params.prompt;
        req.session.authCodeRequest.account = params.account;

        req.session.tokenRequest.authority = params.authority;
        req.session.tokenRequest.scopes = params.scopes;
        req.session.tokenRequest.redirectUri = params.redirect;

        // request an authorization code to exchange for tokens
        try {
            const response = await this.msalClient.getAuthCodeUrl(req.session.authCodeRequest);
            res.redirect(response);
        } catch (error) {
            Logger.logError(ErrorMessages.AUTH_CODE_NOT_OBTAINED);
            next(error);
        }
    };

    /**
     * Handles group overage claims by querying MS Graph /memberOf endpoint
     * @param {Request} req: express request object
     * @param {Response} res: express response object
     * @param {NextFunction} next: express next function
     * @param {AccessRule} rule: a given access rule
     * @returns {Promise}
     */
    private async handleOverage(req: Request, res: Response, next: NextFunction, rule: AccessRule): Promise<void> {
        const { _claim_names, _claim_sources, ...newIdTokenClaims } = <any>req.session.account.idTokenClaims;

        const silentRequest: SilentFlowRequest = {
            account: req.session.account,
            scopes: AccessConstants.GRAPH_MEMBER_SCOPES.split(" "),
        };

        try {
            // acquire token silently to be used in resource call
            const tokenResponse = await this.msalClient.acquireTokenSilent(silentRequest);
            try {
                const graphResponse = await FetchManager.callApiEndpoint(AccessConstants.GRAPH_MEMBERS_ENDPOINT, tokenResponse.accessToken);

                /**
                 * Some queries against Microsoft Graph return multiple pages of data either due to server-side paging 
                 * or due to the use of the $top query parameter to specifically limit the page size in a request. 
                 * When a result set spans multiple pages, Microsoft Graph returns an @odata.nextLink property in 
                 * the response that contains a URL to the next page of results. Learn more at https://docs.microsoft.com/graph/paging
                 */
                if (graphResponse[AccessConstants.PAGINATION_LINK]) {
                    try {
                        const userGroups = await FetchManager.handlePagination(tokenResponse.accessToken, graphResponse[AccessConstants.PAGINATION_LINK]);

                        req.session.account.idTokenClaims = {
                            ...newIdTokenClaims,
                            groups: userGroups
                        }

                        if (!this.checkAccessRule(req.method, rule, req.session.account.idTokenClaims[AccessConstants.GROUPS], AccessConstants.GROUPS)) {
                            return res.redirect(this.appSettings.authRoutes.unauthorized);
                        } else {
                            return next();
                        }
                    } catch (error) {
                        next(error);
                    }
                } else {
                    req.session.account.idTokenClaims = {
                        ...newIdTokenClaims,
                        groups: graphResponse["value"].map((v) => v.id)
                    }

                    if (!this.checkAccessRule(req.method, rule, req.session.account.idTokenClaims[AccessConstants.GROUPS], AccessConstants.GROUPS)) {
                        return res.redirect(this.appSettings.authRoutes.unauthorized);
                    } else {
                        return next();
                    }
                }
            } catch (error) {
                next(error);
            }
        } catch (error) {
            next(error);
        }
    }

    /**
     * Checks if the request passes a given access rule
     * @param {string} method: HTTP method for this route
     * @param {AccessRule} rule: access rule for this route
     * @param {Array} creds: user's credentials i.e. roles or groups
     * @param {string} credType: roles or groups
     * @returns {boolean}
     */
    private checkAccessRule(method: string, rule: AccessRule, creds: string[], credType: string): boolean {
        if (rule.methods.includes(method)) {
            switch (credType) {
                case AccessConstants.GROUPS:
                    if (rule.groups.filter(elem => creds.includes(elem)).length < 1) {
                        Logger.logError(ErrorMessages.USER_NOT_IN_GROUP);
                        return false;
                    }
                    break;

                case AccessConstants.ROLES:
                    if (rule.roles.filter(elem => creds.includes(elem)).length < 1) {
                        Logger.logError(ErrorMessages.USER_NOT_IN_ROLE);
                        return false;
                    }
                    break;

                default:
                    break;
            }
        } else {
            Logger.logError(ErrorMessages.METHOD_NOT_ALLOWED);
            return false;
        }

        return true;
    }

    /**
     * Util method to get the resource name for a given scope(s)
     * @param {Array} scopes: an array of scopes that the resource is associated with
     * @returns {string}
     */
    private getResourceNameFromScopes(scopes: string[]): string {
        // TODO: deep check equality here 

        const index = Object.values({ ...this.appSettings.remoteResources, ...this.appSettings.ownedResources })
            .findIndex((resource: Resource) => JSON.stringify(resource.scopes) === JSON.stringify(scopes));

        const resourceName = Object.keys({ ...this.appSettings.remoteResources, ...this.appSettings.ownedResources })[index];
        return resourceName;
    };
}
