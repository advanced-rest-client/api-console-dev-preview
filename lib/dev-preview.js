'use strict';
/**
 * Copyright (C) Mulesoft.
 * Shared under Apache 2.0 license
 *
 * @author Pawel Psztyc
 */
const {SourceControl} = require('./source-control');
const {PreviewOptions} = require('./preview-options');
const {ApiConsoleSources} = require('api-console-sources-resolver');
const {ApiConsoleTransport} = require('api-console-github-resolver');
const {ApiConsoleGithubResolver, ApiConsoleGithubResolverOptions} =
  require('api-console-github-resolver');
const {ApiConsoleTemplatesProcessor} = require('api-console-builder-templates');
const consoleDependencies = require('api-console-dependency-manager');
const {RamlSource} = require('./raml-source');
const {PreviewServer} = require('./server');
const {CommunicationBridge} = require('./communication');
const winston = require('winston');
const path = require('path');
const polyserve = require('polyserve');
const gulp = require('gulp');
const url = require('url');
/**
 * A class responsible for performing basic operations on a source files
 * and build locations.
 */
class ApiConsoleDevPreview {
  /**
   * Constructs the project.
   *
   * @param {BuilderOptions} opts Options passed to the module
   * @param {Winston} logger Logger to use to log debug output
   */
  constructor(opts) {
    if (!(opts instanceof PreviewOptions)) {
      opts = new PreviewOptions(opts);
    }
    this.opts = opts;
    this.logger = this.__setupLogger();
    if (!this.opts.isValid) {
      this.printValidationErrors();
      this.printValidationWarnings();
      throw new Error('Options did not passed validation.');
    }
    this.printValidationWarnings();

    // Working dir from which the command was executed.
    this.startDir = process.cwd();
  }

  /**
   * Creates a logger object to log debug output.
   */
  __setupLogger() {
    var level = this.opts.verbose ? 'debug' : 'error';
    return new (winston.Logger)({
      transports: [
        new (winston.transports.Console)({level: level}),
        new (winston.transports.File)({
          filename: 'api-console-debug.log',
          level: 'error'
        })
      ]
    });
  }
  /**
   * A class that manages API Console sources
   *
   * @return {SourceControl}
   */
  get sourceControl() {
    if (!this.__sourceControl) {
      this.__sourceControl = new SourceControl(this.logger);
    }
    return this.__sourceControl;
  }

  /**
   * Returns a reference to a TemplatesProcessor.
   * This getter shouldn't be called before working dir has been created or it
   * will be instantialized with undefined working location.
   *
   * @return {TemplatesProcessor}
   */
  get templatesProcessor() {
    if (!this.__templatesProcessor) {
      let opts = {};
      this.__templatesProcessor = new ApiConsoleTemplatesProcessor(
        this.sourceControl.workingDir, this.logger, opts);
      this.__templatesProcessor.setTemplates();
    }
    return this.__templatesProcessor;
  }
  /**
   * Returns a reference to an ApiConsoleSources.
   *
   * @return {ApiConsoleSources}
   */
  get consoleSources() {
    if (!this.__consoleSources) {
      var token = process.env.GITHUB_TOKEN;
      const resolverOpts = new ApiConsoleGithubResolverOptions({
        token: token
      });
      const resolver = new ApiConsoleGithubResolver(resolverOpts);
      const transport = new ApiConsoleTransport();
      const opts = this._getApiConsoleSourcesOptions();
      const sources = new ApiConsoleSources(opts, resolver, transport, this.logger);
      this.__consoleSources = sources;
    }
    return this.__consoleSources;
  }

  /**
   * A class that generates a JSON from raml.
   *
   * @return {RamlSource}
   */
  get ramlSource() {
    if (!this.__ramlSource) {
      this.__ramlSource = new RamlSource(this.logger);
    }
    return this.__ramlSource;
  }

  _getApiConsoleSourcesOptions() {
    var opts = {};
    if (typeof this.opts.tagVersion !== 'undefined') {
      opts.tagVersion = this.opts.tagVersion;
    }
    if (typeof this.opts.src !== 'undefined') {
      opts.src = this.opts.src;
    }
    if (typeof this.opts.sourceIsZip !== 'undefined') {
      opts.sourceIsZip = this.opts.sourceIsZip;
    }
    return opts;
  }

  printValidationErrors() {
    this.opts.validationErrors.forEach((error) => {
      this.logger.error(error);
    });
  }

  printValidationWarnings() {
    var warnings = this.opts.validationWarnings;
    if (!warnings || !warnings.length) {
      return;
    }
    warnings.forEach((warning) => {
      this.logger.warn(warning);
    });
  }

  run() {
    return this._prepareBuild()
    .then(() => this._runWsServer())
    .then(() => this._injectScripts())
    .then(() => this._runWebServer())
    .then(() => this._observeApi());
  }

  /**
   * Contains all the tasks that have to be executed before running the builder.
   * After this function is finished sources are download to a temporary
   * location (`this.sourceControl.workingDir`), the `raml` property is set (if RAML was
   * specified in the options) and console's dependencies has been installed.
   *
   * @return {Promise} Resolved promise when all pre-build work has been
   * completed.
   */
  _prepareBuild() {
    this.logger.info('Preparing sources before build...');
    return this._sourcesToWorkingDirectory()
    .then(() => this._manageDependencies())
    .then(() => this._prebuildTemplates())
    .then(() => this._setRaml())
    .then(raml => this.templatesProcessor.updateTemplateVars(raml || {}));
  }

  /**
   * Creates a working directory and copies console's sources to it.
   * Also clears build dir.
   *
   * @return {Promise} Resolved promise on success.
   */
  _sourcesToWorkingDirectory() {
    return this.sourceControl.createWorkingDir()
    .then(() => {
      return this.consoleSources.sourcesTo(this.sourceControl.workingDir);
    });
  }

  /**
   * Installs console's dependencies and if needed copies console source
   * files to `bower_components` directory.
   *
   * @return {Promise}
   */
  _manageDependencies() {
    let opts = this._createDepenencyManagerOptions();
    return consoleDependencies.installDependencies(this.sourceControl.workingDir, this.logger, opts)
    .then(() => {
      return this.consoleSources.moveConsoleToBower(this.sourceControl.workingDir);
    });
  }

  /**
   * Creates an options object for the dependency manager module from current
   * options.
   */
  _createDepenencyManagerOptions() {
    var opts = {};
    if (this.opts.verbose) {
      opts.verbose = this.opts.verbose;
    }
    return opts;
  }

  /**
   * Copies templates to the working directory and updates path to bower components
   * if needed.
   * @return {Promise}
   */
  _prebuildTemplates() {
    return this.templatesProcessor.copyTemplateFiles()
    .then(() => {
      return this.templatesProcessor.rewriteBowerPaths();
    });
  }

  /**
   * Reads the RAML data, transforms them to JavaScript object, enhances for
   * the console and sets `this.raml` property.
   */
  _setRaml() {
    const location = path.join(this.opts.projectRoot, this.opts.api);
    return this.ramlSource.getRamlJson(location, this.sourceControl.workingDir)
    .then(raml => this.raml = raml);
  }

  _runWsServer() {
    this.server = new PreviewServer();
    this.server.sendRaml(this.raml);
  }

  _injectScripts() {
    const port = this.server.port;
    const mainFileLocation = path.join(this.sourceControl.workingDir,
      this.templatesProcessor.opts.mainFile);
    const bridge = new CommunicationBridge('127.0.0.1', port);
    return bridge.inject(mainFileLocation);
  }

  _runWebServer() {
    const startServers = polyserve.startServers;
    const getServerUrls = polyserve.getServerUrls;
    const opts = this._webServerOptions();

    const originalDir = process.cwd();
    process.chdir(this.sourceControl.workingDir);

    return startServers(opts)
    .then((serverInfos) => {
      process.chdir(originalDir);
      if (serverInfos.kind === 'mainline') {
        const mainlineServer = serverInfos;
        const urls = getServerUrls(this.opts, mainlineServer.server);
        console.info(
            `Files in this directory are available under the following URLs
        applications: ${url.format(urls.serverUrl)}
      `);
      } else {
        // We started multiple servers, just tell the user about the control
        // server, it serves out human-readable info on how to access the others.
        const urls = getServerUrls(this.opts, serverInfos.control.server);
        console.info(`Started multiple servers with different variants:
        View the Polyserve console here: ${url.format(urls.serverUrl)}`);
      }
    });
  }

  _webServerOptions() {
    var opts = {};
    if (this.opts.port) {
      opts.port = this.opts.port;
    }
    if (this.opts.hostname) {
      opts.hostname = this.opts.hostname;
    }
    if (this.opts.open) {
      opts.open = this.opts.open;
    }
    return opts;
  }
  // This function is called outside the API working dir!
  _observeApi() {
    gulp.watch(this.opts.projectRoot + '/**/*.*', this._fileChangedHandler.bind(this));
  }

  _fileChangedHandler() {
    return this._updateApiData()
    .catch(cause => {
      const message = 'RAML Parser error: ' + cause.message;
      this.server.sendError('critical', message);
    });
  }

  _updateApiData() {
    return this._setRaml()
    .then(raml => {
      this.raml = raml;
      this.server.sendRaml(raml);
    });
  }
}

exports.ApiConsoleDevPreview = ApiConsoleDevPreview;
