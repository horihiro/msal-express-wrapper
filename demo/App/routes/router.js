const express = require('express');
const mainController = require('../controllers/mainController');
const appSettings = require('../appSettings');

module.exports = (authProvider) => {
    // initialize router
    const router = express.Router();

    // app routes
    router.get('/', (req, res, next) => res.redirect('/home'));
    router.get('/home', mainController.getHomePage);

    // secure routes
    router.get('/id', 
        authProvider.isAuthenticated(),
        mainController.getIdPage
    );

    router.get('/profile', 
        authProvider.isAuthenticated(), 
        authProvider.getToken({
            resource: appSettings.remoteResources.graphAPI
        }),
        mainController.getProfilePage
    ); // get token for this route to call web API

    router.get('/tenant', 
        authProvider.isAuthenticated(), 
        authProvider.getToken({
            resource: appSettings.remoteResources.armAPI
        }), 
        mainController.getTenantPage
    ); // get token for this route to call web API

    // unauthorized
    router.get('/error', (req, res) => res.redirect('/401.html'));

    // error
    router.get('/unauthorized', (req, res) => res.redirect('/500.html'));

    // 404
    router.get('*', (req, res) => res.redirect('/404.html'));

    return router;
}