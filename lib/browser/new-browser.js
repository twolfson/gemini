'use strict';

var path = require('path'),
    util = require('util'),
    debug = require('debug'),
    _ = require('lodash'),
    q = require('q'),
    chalk = require('chalk'),
    polyfillService = require('polyfill-service'),
    browserify = require('browserify'),

    Browser = require('./browser'),
    ClientBridge = require('./client-bridge'),

    GeminiError = require('../errors/gemini-error'),
    WdErrors = require('../constants/wd-errors'),

    OPERA_NOT_SUPPORTED = 'Not supported in OperaDriver yet';

module.exports = class NewBrowser extends Browser {
    constructor(config) {
        super(config);

        this.log = debug('gemini:browser:' + this.id);

        var wdLog = debug('gemini:webdriver:' + this.id);

        this._wd.on('connection', function(code, message, error) {
            wdLog('Error: code %d, %s', code, message);
        });

        this._wd.on('status', function(info) {
            wdLog(info);
        });
        this._wd.on('command', function(eventType, command, response) {
            if (eventType === 'RESPONSE' && command === 'takeScreenshot()') {
                response = '<binary-data>';
            }
            if (typeof response !== 'string') {
                response = JSON.stringify(response);
            }
            wdLog(chalk.cyan(eventType), command, chalk.grey(response || ''));
        });

        this._exposeWdApi([
            'sleep',
            'waitForElementByCssSelector',
            'waitFor',
            'moveTo',
            'click',
            'doubleClick',
            'buttonDown',
            'buttonUp',
            'keys',
            'type',
            'tapElement',
            'flick',
            'execute',
            'setWindowSize',
            'getWindowSize'
        ]);
    }

    _exposeWdApi(methods) {
        var _this = this;
        methods.forEach(function(method) {
            _this[method] = function() {
                return _this._wd[method].apply(_this._wd, arguments);
            };
        });
    }

    launch(calibrator) {
        var _this = this;
        return this.initSession()
            .then(function() {
                return _this._setDefaultSize();
            })
            .then(function() {
                //maximize is required, because default
                //windows size in phantomjs can prevent
                //some shadows from fitting in
                if (_this._shouldMaximize()) {
                    return _this._maximize();
                }
            })
            .then(function() {
                if (!_this.config.calibrate  || _this._calibration) {
                    return;
                }
                return calibrator.calibrate(_this)
                    .then(_this._setCalibration.bind(_this));
            })
            .then(function() {
                return _this._buildPolyfills();
            })
            .then(function() {
                return _this.buildScripts();
            })
            .then(function() {
                return _this.chooseLocator();
            })
            .fail(function(e) {
                if (e.code === 'ECONNREFUSED') {
                    return q.reject(new GeminiError(
                        'Unable to connect to ' + _this.config.gridUrl,
                        'Make sure that URL in config file is correct and selenium\nserver is running.'
                    ));
                }

                var error = new GeminiError(
                    util.format('Cannot launch browser %s:\n%s', _this.id, e.message)
                );

                error.browserId = _this.id;
                error.browserSessionId = _this.sessionId;
                // sadly, selenium does not provide a way to distinguish different
                // reasons of failure
                return q.reject(error);
            });
    }

    initSession() {
        var _this = this;

        return this._wd
            .configureHttp({
                retries: 'never',
                timeout: this.config.httpTimeout
            })
            .then(function() {
                return _this._wd.init(_this.capabilities);
            })
            .spread(function(sessionId, actualCapabilities) {
                _this.sessionId = sessionId;
                _this.log('launched session %o', _this);
            });
    }

    _setDefaultSize() {
        var size = this.config.windowSize;
        if (!size) {
            return;
        }
        return this._wd.setWindowSize(size.width, size.height)
            .fail(function(e) {
                // Its the only reliable way to detect not supported operation
                // in legacy operadriver.
                var message = e.cause && e.cause.value && e.cause.value.message;
                if (message === OPERA_NOT_SUPPORTED) {
                    console.warn(chalk.yellow('WARNING!'));
                    console.warn('Legacy Opera Driver does not support window resizing');
                    console.warn('windowSize setting will be ignored.');
                    return;
                }
                return q.reject(e);
            });
    }

    _buildPolyfills() {
        /*jshint evil:true*/
        //polyfills are needed for older browsers, namely, IE8

        var _this = this;
        return _this._wd.eval('navigator.userAgent')
            .then(function(ua) {
                return polyfillService.getPolyfillString({
                    uaString: ua,
                    minify: true,
                    features: {
                        'getComputedStyle': {flags: ['gated']},
                        'matchMedia': {flags: ['gated']},
                        'document.querySelector': {flags: ['gated']},
                        'String.prototype.trim': {flags: ['gated']}
                    }
                });
            })
            .then(function(polyfill) {
                _this._polyfill = polyfill;
            });
    }

    openRelative(relativeURL) {
        return this.open(this.config.getAbsoluteUrl(relativeURL));
    }

    // Zoom reset should be skipped before calibration cause we're unable to build client scripts before
    // calibration done. Reset will be executed as 1 of calibration steps.
    open(url, params) {
        params = _.defaults(params || {}, {
            resetZoom: true
        });

        var _this = this;
        return this._wd.get(url)
            .then(function(result) {
                return params.resetZoom
                    ? _this._clientBridge.call('resetZoom').thenResolve(result)
                    : result;
            });
    }

    injectScript(script) {
        return this._wd.execute(script);
    }

    evalScript(script) {
        /*jshint evil:true*/
        return this._wd.eval(script);
    }

    buildScripts() {
        var script = browserify({
                entries: './gemini',
                basedir: path.join(__dirname, 'client-scripts')
            });

        if (!this.config.system.coverage.enabled) {
            script.exclude('./gemini.coverage');
        }

        script.transform({sourcemap: false, global: true}, 'uglifyify');
        var queryLib = this._needsSizzle? './query.sizzle.js' : './query.native.js';
        script.transform({
            aliases: {
                './query': {relative: queryLib}
            },
            verbose: false
        }, 'aliasify');

        var _this = this;

        return q.nfcall(script.bundle.bind(script))
            .then(function(buf) {
                var scripts = _this._polyfill + '\n' + buf.toString();
                _this._clientBridge = new ClientBridge(_this, scripts);
                return scripts;
            });
    }

    get _needsSizzle() {
        return this._calibration && !this._calibration.hasCSS3Selectors;
    }

    chooseLocator() {
        this.findElement = this._needsSizzle? this._findElementScript : this._findElementWd;
    }

    reset() {
        var _this = this;
        // We can't use findElement here because it requires page with body tag
        return this.evalScript('document.body')
            .then(function(body) {
                // Selenium IEDriver doesn't move cursor to (0, 0) first time
                // https://github.com/SeleniumHQ/selenium/issues/672
                // So we do it in two steps: -> (1, 1) -> (0, 0)
                return _this._wd.moveTo(body, 1, 1)
                    .then(_this._wd.moveTo.bind(_this._wd, body, 0, 0));
            })
            .fail(function(e) {
                return q.reject(_.extend(e || {}, {
                    browserId: _this.id,
                    sessionId: _this.sessionId
                }));
            });
    }

    get browserName() {
        return this.capabilities.browserName;
    }

    get version() {
        return this.capabilities.version;
    }

    get capabilities() {
        return this.config.desiredCapabilities;
    }

    _shouldMaximize() {
        if (this.config.windowSize) {
            return false;
        }

        return this.browserName === 'phantomjs';
    }

    _maximize() {
        var _this = this;
        return _this._wd.windowHandle()
            .then(function(handle) {
                return _this._wd.maximize(handle);
            });
    }

    findElement(selector) {
        throw new Error('findElement is called before appropriate locator is chosen');
    }

    _findElementWd(selector) {
        return this._wd.elementByCssSelector(selector)
            .fail(function(error) {
                if (error.status === WdErrors.ELEMENT_NOT_FOUND) {
                    error.selector = selector;
                }
                return q.reject(error);
            });
    }

    _findElementScript(selector) {
        return this._clientBridge.call('query.first', [selector])
            .then(function(element) {
                if (element) {
                    return element;
                }

                var error = new Error('Unable to find element');
                error.status = WdErrors.ELEMENT_NOT_FOUND;
                error.selector = selector;
                return q.reject(error);
            });
    }

    prepareScreenshot(selectors, opts) {
        return this._clientBridge.call('prepareScreenshot', [selectors, opts || {}]);
    }

    get usePixelRatio() {
        return this._calibration && this._calibration.usePixelRatio;
    }

    quit() {
        if (!this.sessionId) {
            return q();
        }

        var _this = this;
        return this._wd
            .quit()
            .then(function() {
                _this.log('kill browser %o', _this);
            });
    }

    inspect() {
        return util.format('[%s (%s)]', this.id, this.sessionId);
    }
};
