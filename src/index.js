'use strict';

module.exports = S => {
  
  require('coffee-script/register');
  
  const fs = require('fs');
  const path = require('path');
  const Hapi = require('hapi');
  const isPlainObject = require('lodash.isplainobject');
  
  const debugLog = require('./debugLog');
  const serverlessLog = S.config && S.config.serverlessPath ? 
    require(path.join(S.config.serverlessPath, 'utils', 'cli')).log :
    console.log.bind(null, 'Serverless:');
  
  const jsonPath = require('./jsonPath');
  const createLambdaContext = require('./createLambdaContext');
  const createVelocityContext = require('./createVelocityContext');
  const renderVelocityTemplateObject = require('./renderVelocityTemplateObject');
  
  function logPluginIssue() {
    serverlessLog('If you think this is an issue with the plugin please submit it, thanks!');
    serverlessLog('https://github.com/dherault/serverless-offline/issues');
  }

  return class Offline extends S.classes.Plugin {
    
    static getName() {
      return 'serverless-offline';
    }
    
    registerActions() {
      S.addAction(this.start.bind(this), {
        handler:       'start',
        description:   'Simulates API Gateway to call your lambda functions offline',
        context:       'offline',
        contextAction: 'start',
        options:       [
          {
            option:      'prefix',
            shortcut:    'p',
            description: 'Adds a prefix to every path, to send your requests to http://localhost:3000/prefix/[your_path] instead.'
          }, 
          {
            option:      'port',
            shortcut:    'P',
            description: 'Port to listen on. Default: 3000'
          }, 
          {
            option:       'stage',
            shortcut:     's',
            description:  'The stage used to populate your templates. Default: the first stage found in your project'
          }, 
          {
            option:       'region',
            shortcut:     'r',
            description:  'The region used to populate your templates. Default: the first region for the first stage found.'
          }, 
          {
            option:       'corsHeaders',
            shortcut:     'H',
            description:  'Optional - Set allowed CORS headers for all endpoints. Default: Accept, Authorization, Content-Type, and If-None-Match.'
          }, 
          {
            option:       'skipCacheInvalidation',
            shortcut:     'c',
            description:  'Tells the plugin to skip require cache invalidation. A script reloading tool like Nodemon might then be needed'
          }, 
          {
            option:       'httpsProtocol',
            shortcut:     'H',
            description:  'To enable HTTPS, specify directory (relative to your cwd, typically your project dir) for both cert.pem and key.pem files.'
          }
        ]
      });
      return Promise.resolve();
    }
    
    registerHooks() {
      return Promise.resolve();
    }
    
    start(optionsAndData) {
      // this._logAndExit(optionsAndData);
      
      const version = S._version;
      if (!version.startsWith('0.5')) {
        serverlessLog(`Offline requires Serverless v0.5.x but found ${version}. Exiting.`);
        process.exit(0);
      }
      
      process.env.IS_OFFLINE = true;
      this.envVars = {};
      this.project = S.getProject();
      
      this._setOptions();
      this._registerBabel();
      this._createServer();
      this._createRoutes();
      this._listen();
    }
    
    _setOptions() {
      
      if (!S.cli || !S.cli.options) throw new Error('Offline could not load options from Serverless');
      
      const userOptions = S.cli.options;
      const stages = this.project.stages;
      const stagesKeys = Object.keys(stages);
      
      if (!stagesKeys.length) {
        serverlessLog('Offline could not find a default stage for your project: it looks like your _meta folder is empty. If you cloned your project using git, try "sls project init" to recreate your _meta folder');
        process.exit(0);
      }
      
      this.options = {
        port: userOptions.port || 3000,
        prefix: userOptions.prefix || '/',
        stage: userOptions.stage || stagesKeys[0],
        skipCacheInvalidation: userOptions.skipCacheInvalidation || false,
        httpsProtocol: userOptions.httpsProtocol || '',
      };
      
      // Parse CORS headers if included in Serverless plugin config or userOptions. If the are undefined then hapi uses the default.
      if (userOptions.corsHeaders) {
        this.options.corsHeaders = userOptions.corsHeaders.split(',').map(h => h.trim());
        debugLog('Parsed custom CORS headers:', this.options.corsHeaders);
      } else if (this.options.custom && this.options.custom.corsHeaders) {
        this.options.corsHeaders = this.options.custom.corsHeaders;
      }

      const stageVariables = stages[this.options.stage];
      this.options.region = userOptions.region || Object.keys(stageVariables.regions)[0];
      
      // Prefix must start and end with '/'
      if (!this.options.prefix.startsWith('/')) this.options.prefix = '/' + this.options.prefix;
      if (!this.options.prefix.endsWith('/')) this.options.prefix += '/';
      
      this.globalBabelOptions = ((this.project.custom || {})['serverless-offline'] || {}).babelOptions;
      
      this.velocityContextOptions = {
        stageVariables,
        stage: this.options.stage,
      };
      
      serverlessLog(`Starting Offline: ${this.options.stage}/${this.options.region}.`);
      debugLog('options:', this.options);
      debugLog('globalBabelOptions:', this.globalBabelOptions);
    }
    
    _registerBabel(isBabelRuntime, babelRuntimeOptions) {
      
      const options = isBabelRuntime ? 
        babelRuntimeOptions || { presets: ['es2015'] } :
        this.globalBabelOptions;
      
      if (options) {
        debugLog('Setting babel register:', options);
        
        if (!this.babelRegister) {
          debugLog('For the first time');
          this.babelRegister = require('babel-register');
        }
        
        this.babelRegister(options);
      }
    }
    
    _createServer() {
      
      this.server = new Hapi.Server({
        connections: {
          router: {
            stripTrailingSlash: true // removes trailing slashes on incoming paths.
          }
        }
      });
      
      const connectionOptions = { port: this.options.port };
      const httpsDir = this.options.httpsProtocol;
      
      if (typeof httpsDir === 'string' && httpsDir.length > 0) connectionOptions.tls = {
        key: fs.readFileSync(path.resolve(httpsDir, 'key.pem'), 'ascii'),
        cert: fs.readFileSync(path.resolve(httpsDir, 'cert.pem'), 'ascii')
      };
      
      this.server.connection(connectionOptions);
    }
    
    _createRoutes() {
      const functions = this.project.getAllFunctions();
      const defaultContentType = 'application/json';
      
      functions.forEach(fun => {
        
        // Runtime checks
        // No python :'(
        const funRuntime = fun.runtime;
        if (funRuntime !== 'nodejs' && funRuntime !== 'babel') return;
        
        // Templates population (with project variables)
        let populatedFun;
        try {
          populatedFun = fun.toObjectPopulated({
            stage: this.options.stage,
            region: this.options.region,
          });
        }
        catch(err) {
          serverlessLog(`Error while populating function '${fun.name}' with stage '${this.options.stage}' and region '${this.options.region}':`);
          this._logAndExit(err.stack);
        }
        
        const funName = fun.name;
        const handlerParts = fun.handler.split('/').pop().split('.');
        const handlerPath = fun.getRootPath(handlerParts[0]);
        const funTimeout = fun.timeout ? fun.timeout * 1000 : 6000;
        const funBabelOptions = ((fun.custom || {}).runtime || {}).babel;
        
        console.log();
        debugLog(funName, 'runtime', funRuntime, funBabelOptions || '');
        serverlessLog(`Routes for ${funName}:`);
        
        // Add a route for each endpoint
        populatedFun.endpoints.forEach(endpoint => {
          
          let firstCall = true;
          
          const epath = endpoint.path;
          const method = endpoint.method.toUpperCase();
          const requestTemplates = endpoint.requestTemplates;
          
          // Prefix must start and end with '/' BUT path must not end with '/'
          let path = this.options.prefix + (epath.startsWith('/') ? epath.slice(1) : epath);
          if (path !== '/' && path.endsWith('/')) path = path.slice(0, -1);
          
          serverlessLog(`${method} ${path}`);
          
          // Route configuration
          const config = { cors: { headers: this.options.corsHeaders } };
          
          // When no content-type is provided on incomming requests, APIG sets 'application/json'
          if (method !== 'GET' && method !== 'HEAD') config.payload = { override: defaultContentType };
          
          this.server.route({
            method, 
            path,
            config, 
            handler: (request, reply) => {
              console.log();
              serverlessLog(`${method} ${request.url.path} (λ: ${funName})`);
              if (firstCall) {
                serverlessLog('The first request might take a few extra seconds');
                firstCall = false;
              }
              
              // Holds the response to do async op
              const response = reply.response().hold();
              const contentType = request.mime || defaultContentType;
              const requestTemplate = requestTemplates[contentType];
              
              debugLog('contentType:', contentType);
              debugLog('requestTemplate:', requestTemplate);
              debugLog('payload:', request.payload);
              
              /* ENVIRONMENT VARIABLES CONFIGURATION */
              
              // Clear old vars
              for (let key in this.envVars) {
                delete process.env[key];
              }
              
              // Declare new ones
              this.envVars = isPlainObject(populatedFun.environment) ? populatedFun.environment : {};
              for (let key in this.envVars) {
                process.env[key] = this.envVars[key];
              }
              
              /* BABEL CONFIGURATION */
              
              this._registerBabel(funRuntime === 'babel', funBabelOptions);
              
              /* HANDLER LAZY LOADING */
              
              let handler;
              try {
                if (!this.options.skipCacheInvalidation) {
                  debugLog('Invalidating cache...');
                  
                  for (let key in require.cache) {
                    // Require cache invalidation, brutal and fragile. Might cause errors, if so, please submit issue.
                    if (!key.match('node_modules')) delete require.cache[key];
                  }
                }
                
                debugLog(`Loading handler... (${handlerPath})`);
                handler = require(handlerPath)[handlerParts[1]];
                if (typeof handler !== 'function') throw new Error(`Serverless-offline: handler for function ${funName} is not a function`);
              } 
              catch(err) {
                return this._reply500(response, `Error while loading ${funName}`, err);
              }
              
              let event = {};
              
              /* REQUEST TEMPLATE PROCESSING (event population) */
              
              if (!requestTemplate) {
                console.log();
                serverlessLog(`Warning: no template found for '${contentType}' content-type.`);
                console.log();
              } else {
                try {
                  debugLog('_____ REQUEST TEMPLATE PROCESSING _____');
                  const velocityContext = createVelocityContext(request, this.velocityContextOptions, request.payload || {});
                  event = renderVelocityTemplateObject(requestTemplate, velocityContext);
                }
                catch (err) {
                  return this._reply500(response, `Error while parsing template "${contentType}" for ${funName}`, err);
                }
              }
              
              event.isOffline = true; 
              debugLog('event:', event);
              
              // We cannot use Hapijs's timeout feature because the logic above can take a significant time, so we implement it ourselves
              let timeoutTimeout; // It's a timeoutObject, for... timeout. timeoutTimeout ?
              
              // We create the context, its callback (context.done/succeed/fail) will send the HTTP response
              const lambdaContext = createLambdaContext(fun, (err, data) => {
                
                debugLog('_____ HANDLER RESOLVED _____');
                
                if (timeoutTimeout._called) return;
                else clearTimeout(timeoutTimeout);
                
                let result = data;
                let responseName = 'default';
                let responseContentType = defaultContentType;
                
                /* RESPONSE SELECTION (among endpoint's possible responses) */
                
                // Failure handling
                if (err) {
                  const errorMessage = err.message || err.toString();
                  
                  // Mocks Lambda errors
                  result = { 
                    errorMessage,
                    errorType: err.constructor.name,
                    stackTrace: err.stack ? err.stack.split('\n') : null
                  };
                  
                  serverlessLog(`Failure: ${errorMessage}`);
                  if (err.stack) console.log(err.stack);
                  
                  for (let key in endpoint.responses) {
                    if (key === 'default') continue;
                    
                    // I don't know why lambda choose to enforce the "starting with" condition on their regex
                    if (errorMessage.match('^' + (endpoint.responses[key].selectionPattern || key))) {
                      responseName = key;
                      break;
                    }
                  }
                }
                
                debugLog(`Using response '${responseName}'`);
                
                const chosenResponse = endpoint.responses[responseName];
                
                /* RESPONSE PARAMETERS PROCCESSING */
                
                const responseParameters = chosenResponse.responseParameters;
                
                if (isPlainObject(responseParameters)) {
                  
                  const responseParametersKeys = Object.keys(responseParameters);
                  
                  debugLog('_____ RESPONSE PARAMETERS PROCCESSING _____');
                  debugLog(`Found ${responseParametersKeys.length} responseParameters for '${responseName}' response`);
                  
                  responseParametersKeys.forEach(key => {
                    
                    // responseParameters use the following shape: "key": "value"
                    const value = responseParameters[key];
                    const keyArray = key.split('.'); // eg: "method.response.header.location"
                    const valueArray = value.split('.'); // eg: "integration.response.body.redirect.url"
                    
                    debugLog(`Processing responseParameter "${key}": "${value}"`);
                    
                    // For now the plugin only supports modifying headers
                    if (key.startsWith('method.response.header') && keyArray[3]) {
                      
                      const headerName = keyArray.slice(3).join('.');
                      let headerValue;
                      debugLog('Found header in left-hand:', headerName);
                      
                      if (value.startsWith('integration.response')) {
                        if (valueArray[2] === 'body') {
                          
                          debugLog('Found body in right-hand');
                          headerValue = JSON.stringify(valueArray[3] ? jsonPath(result, valueArray.slice(3).join('.')) : result);
                          
                        } else {
                          console.log();
                          serverlessLog(`Warning: while processing responseParameter "${key}": "${value}"`);
                          serverlessLog(`Offline plugin only supports "integration.response.body[.JSON_path]" right-hand responseParameter. Found "${value}" instead. Skipping.`);
                          logPluginIssue();
                          console.log();
                        }
                      } else {
                        headerValue = value;
                      }
                      // Applies the header;
                      debugLog(`Will assign "${headerValue}" to header "${headerName}"`);
                      response.header(headerName, headerValue);
                    } 
                    else {
                      console.log();
                      serverlessLog(`Warning: while processing responseParameter "${key}": "${value}"`);
                      serverlessLog(`Offline plugin only supports "method.response.header.PARAM_NAME" left-hand responseParameter. Found "${key}" instead. Skipping.`);
                      logPluginIssue();
                      console.log();
                    }
                  });
                }
                
                /* RESPONSE TEMPLATE PROCCESSING */
                
                // If there is a responseTemplate, we apply it to the result
                const responseTemplates = chosenResponse.responseTemplates;
                
                if (isPlainObject(responseTemplates)) {
                  
                  const responseTemplatesKeys = Object.keys(responseTemplates);
                  
                  if (responseTemplatesKeys.length) {
                    
                    // BAD IMPLEMENTATION: first key in responseTemplates
                    const templateName = responseTemplatesKeys[0];
                    const responseTemplate = responseTemplates[templateName];
                    
                    responseContentType = templateName;
                    
                    if (responseTemplate) {
                      
                      debugLog('_____ RESPONSE TEMPLATE PROCCESSING _____');
                      debugLog(`Using responseTemplate '${templateName}'`);
                      
                      try {
                        const reponseContext = createVelocityContext(request, this.velocityContextOptions, result);
                        result = renderVelocityTemplateObject({ root: responseTemplate }, reponseContext).root;
                      }
                      catch (err) {
                        serverlessLog(`Error while parsing responseTemplate '${templateName}' for lambda ${funName}:`);
                        console.log(err.stack);
                      }
                    }
                  }
                }
                
                /* HAPIJS RESPONSE CONFIGURATION */
                
                const statusCode = chosenResponse.statusCode || 200;
                if (!chosenResponse.statusCode) {
                  console.log();
                  serverlessLog(`Warning: No statusCode found for response "${responseName}".`);
                  console.log();
                }
                
                response.header('Content-Type', responseContentType);
                response.statusCode = statusCode;
                response.source = result;
                
                // Log response
                let whatToLog = result;
                
                try {
                  whatToLog = JSON.stringify(result);
                } 
                catch(err) {
                  // nothing
                }
                finally {
                  serverlessLog(err ? `Replying ${statusCode}` : `[${statusCode}] ${whatToLog}`);
                }
                
                // Bon voyage!
                response.send();
              });
              
              timeoutTimeout = setTimeout(this._replyTimeout.bind(this, response, funName, funTimeout), funTimeout);
              
              // Finally we call the handler
              debugLog('_____ CALLING HANDLER _____');
              try {
                const x = handler(event, lambdaContext);
                
                // Promise support
                if (funRuntime === 'babel') {
                  if (x && typeof x.then === 'function' && typeof x.catch === 'function') x
                    .then(lambdaContext.succeed)
                    .catch(lambdaContext.fail);
                  else if (x instanceof Error) lambdaContext.fail(x);
                  else lambdaContext.succeed(x);
                }
              }
              catch(err) {
                return this._reply500(response, 'Uncaught error in your handler', err);
              }
            },
          });
        });
      });
    }
    
    _listen() {
      this.server.start(err => {
        if (err) throw err;
        console.log();
        serverlessLog(`Offline listening on ${this.options.httpsProtocol ? 'https' : 'http'}://localhost:${this.options.port}`);
      });
    }
    
    _reply500(response, message, err) {
      serverlessLog(message);
      console.log(err.stack || err);
      response.statusCode = 200; // APIG replies 200 by default on failures
      response.source = {
        errorMessage: message,
        errorType: err.constructor.name,
        stackTrace: err.stack ? err.stack.split('\n') : null,
        offlineInfo: 'If you believe this is an issue with the plugin please submit it, thanks. https://github.com/dherault/serverless-offline/issues',
      };
      response.send();
    }
    
    _replyTimeout(response, funName, funTimeout) {
      serverlessLog(`Replying timeout after ${funTimeout}ms`);
      response.statusCode = 503;
      response.source = `[Serverless-offline] Your λ handler ${funName} timed out after ${funTimeout}ms.`;
      response.send();
    }
    
    _logAndExit() {
      console.log.apply(null, arguments);
      process.exit(0);
    }
  };
};
