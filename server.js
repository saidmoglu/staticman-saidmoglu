const bodyParser = require('body-parser')
const config = require('./config')
const express = require('express')
const ExpressBrute = require('express-brute')
const GithubWebHook = require('express-github-webhook')
const objectPath = require('object-path')
const logger = require('./lib/Logger')
const https = require('https')

class StaticmanAPI {
  constructor() {
    this.controllers = {
      connect: require('./controllers/connect'),
      encrypt: require('./controllers/encrypt'),
      auth: require('./controllers/auth'),
      handlePR: require('./controllers/handlePR'),
      home: require('./controllers/home'),
      process: require('./controllers/process')
    }

    this.server = express()

    // Add request logging middleware before other middleware
    this.server.use((req, res, next) => {
      const logData = {
        method: req.method,
        path: req.path,
        params: req.params,
        query: req.query,
        ip: req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress,
        userAgent: req.headers['user-agent']
      }

      logger.info(`Incoming request: ${JSON.stringify(logData)}`)
      next()
    })

    this.server.use(bodyParser.json())
    this.server.use(bodyParser.urlencoded({
      extended: true
    }))

    this.initialiseWebhookHandler()
    this.initialiseCORS()
    this.initialiseBruteforceProtection()
    this.initialiseRoutes()
  }

  initialiseBruteforceProtection() {
    const store = new ExpressBrute.MemoryStore()

    this.bruteforce = new ExpressBrute(store)
  }

  initialiseCORS() {
    this.server.use((req, res, next) => {
      res.header('Access-Control-Allow-Origin', '*')
      res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept')

      next()
    })
  }

  initialiseRoutes() {
    // Route: connect
    this.server.get(
      '/v:version/connect/:username/:repository',
      this.bruteforce.prevent,
      this.requireApiVersion([1, 2]),
      this.controllers.connect
    )

    // Route: process
    this.server.post(
      '/v:version/entry/:username/:repository/:branch',
      this.bruteforce.prevent,
      this.requireApiVersion([1, 2]),
      this.requireParams(['fields']),
      this.controllers.process
    )

    this.server.post(
      '/v:version/entry/:username/:repository/:branch/:property',
      this.bruteforce.prevent,
      this.requireApiVersion([2]),
      this.requireParams(['fields']),
      this.controllers.process
    )

    this.server.post(
      '/v:version/entry/:service/:username/:repository/:branch/:property',
      this.bruteforce.prevent,
      this.requireApiVersion([3]),
      this.requireService(['github', 'gitlab']),
      this.requireParams(['fields']),
      this.controllers.process
    )

    // Route: encrypt
    this.server.get(
      '/v:version/encrypt/:text',
      this.bruteforce.prevent,
      this.requireApiVersion([2, 3]),
      this.controllers.encrypt
    )

    // Route: oauth
    this.server.get(
      '/v:version/auth/:service/:username/:repository/:branch/:property',
      this.bruteforce.prevent,
      this.requireApiVersion([2, 3]),
      this.requireService(['github', 'gitlab']),
      this.controllers.auth
    )

    // Route: root
    this.server.get(
      '/',
      this.controllers.home
    )
  }

  initialiseWebhookHandler() {
    const webhookHandler = GithubWebHook({
      path: '/v1/webhook'
    })

    webhookHandler.on('pull_request', this.controllers.handlePR)

    this.server.use(webhookHandler)
  }

  requireApiVersion(versions) {
    return (req, res, next) => {
      const versionMatch = versions.some(version => {
        return version.toString() === req.params.version
      })

      if (!versionMatch) {
        return res.status(400).send({
          success: false,
          errorCode: 'INVALID_VERSION'
        })
      }

      return next()
    }
  }

  requireService(services) {
    return (req, res, next) => {
      const serviceMatch = services.some(service => service === req.params.service)

      if (!serviceMatch) {
        return res.status(400).send({
          success: false,
          errorCode: 'INVALID_SERVICE'
        })
      }

      return next()
    }
  }

  requireParams(params) {
    return function (req, res, next) {
      let missingParams = []

      params.forEach(param => {
        if (
          objectPath.get(req.query, param) === undefined &&
          objectPath.get(req.body, param) === undefined
        ) {
          missingParams.push(param)
        }
      })

      if (missingParams.length) {
        return res.status(500).send({
          success: false,
          errorCode: 'MISSING_PARAMS',
          data: missingParams
        })
      }

      return next()
    }
  }

  setupPinger() {
    const PING_INTERVAL = 10 * 60 * 1000; // 10 minutes in milliseconds
    const BACKEND_URL = 'https://staticman-saidmoglu.onrender.com';

    setInterval(() => {
      https.get(BACKEND_URL, (resp) => {
        logger.info(`Self-ping performed. Status: ${resp.statusCode}`);
      }).on('error', (err) => {
        logger.info(`Self-ping failed: ${err.message}`);
      });
    }, PING_INTERVAL);

    logger.info('Self-ping mechanism initialized');
  }

  start(callback) {
    this.instance = this.server.listen(config.get('port'), () => {
      this.setupPinger(); // Initialize the self-ping mechanism
      if (typeof callback === 'function') {
        callback(config.get('port'))
      }
    })
  }

  close() {
    this.instance.close()
  }
}

module.exports = StaticmanAPI
