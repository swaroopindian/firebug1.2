/* See license.txt for terms of usage */

FBL.ns(function() { with (FBL) {

// ************************************************************************************************
// Constants

const Cc = Components.classes;
const Ci = Components.interfaces;
const jsdIScript = Ci.jsdIScript;
const jsdIStackFrame = Ci.jsdIStackFrame;
const jsdIExecutionHook = Ci.jsdIExecutionHook;
const nsISupports = Ci.nsISupports;
const nsICryptoHash = Ci.nsICryptoHash;
const nsIURI = Ci.nsIURI;

const PCMAP_SOURCETEXT = jsdIScript.PCMAP_SOURCETEXT;

const RETURN_VALUE = jsdIExecutionHook.RETURN_RET_WITH_VAL;
const RETURN_THROW_WITH_VAL = jsdIExecutionHook.RETURN_THROW_WITH_VAL;
const RETURN_CONTINUE = jsdIExecutionHook.RETURN_CONTINUE;
const RETURN_CONTINUE_THROW = jsdIExecutionHook.RETURN_CONTINUE_THROW;
const RETURN_ABORT = jsdIExecutionHook.RETURN_ABORT;

const TYPE_THROW = jsdIExecutionHook.TYPE_THROW;

const STEP_OVER = 1;
const STEP_INTO = 2;
const STEP_OUT = 3;

// * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * *

const tooltipTimeout = 300;

const reLineNumber = /^[^\\]?#(\d*)$/;

const reEval =  /\s*eval\s*\(([^)]*)\)/m;        // eval ( $1 )
const reHTM = /\.[hH][tT][mM]/;
const reFunction = /\s*Function\s*\(([^)]*)\)/m;

const panelStatus = $("fbPanelStatus");

// ************************************************************************************************

var listeners = [];

// ************************************************************************************************

Firebug.Debugger = extend(Firebug.ActivableModule,
{
    fbs: fbs, // access to firebug-service in chromebug under browser.xul.DOM.Firebug.Debugger.fbs /*@explore*/
    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * *
    // Debugging

    evaluate: function(js, context, scope)
    {
        var frame = context.currentFrame;
        if (!frame)
            return;

        frame.scope.refresh(); // XXX what's this do?

        var result = {};
        var scriptToEval = js;
        if (scope && scope.thisValue) {
            // XXX need to stick scope.thisValue somewhere... frame.scope.globalObject?
            scriptToEval = " (function() { return " + js + " }).apply(__thisValue__);";
        }

        // This seem to be safe; eval'ing a getter property in content that tries to
        // be evil and get Components.classes results in a permission denied error.
        var ok = frame.eval(scriptToEval, "", 1, result);

        var value = result.value.getWrappedValue();
        if (ok)
            return value;
        else
            throw value;
    },

    getCurrentFrameKeys: function(context)
    {
        var globals = keys(context.window.wrappedJSObject);  // return is safe

        if (context.currentFrame)
            return this.getFrameKeys(context.currentFrame, globals);

        return globals;
    },

    getFrameKeys: function(frame, names)
    {
        var listValue = {value: null}, lengthValue = {value: 0};
        frame.scope.getProperties(listValue, lengthValue);

        for (var i = 0; i < lengthValue.value; ++i)
        {
            var prop = listValue.value[i];
            var name = prop.name.getWrappedValue();
            names.push(name);
        }
        return names;
    },

    focusWatch: function(context)
    {
        if (context.detached)
            context.chrome.focus();
        else
            Firebug.toggleBar(true);

        context.chrome.selectPanel("script");

        var watchPanel = context.getPanel("watches", true);
        if (watchPanel)
            watchPanel.editNewWatch();
    },

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * *

    halt: function(fn)
    {
        this.haltCallback = fn;
        fbs.halt(this);
        debugger;
    },

    stop: function(context, frame, type, rv)
    {
        if (context.stopped)
            return RETURN_CONTINUE;

        if (!this.isEnabled(context))
            return RETURN_CONTINUE;

        var executionContext;
        try
        {
            executionContext = frame.executionContext;
        }
        catch (exc)
        {
            // Can't proceed with an execution context - it happens sometimes.
            return RETURN_CONTINUE;
        }

        context.debugFrame = frame;
        context.stopped = true;

        const hookReturn = dispatch2(listeners,"onStop",[context,frame, type,rv]);
        if ( hookReturn && hookReturn >= 0 )
        {
            delete context.stopped;
            delete context.debugFrame;
            delete context;
            return hookReturn;
        }

        try {
            executionContext.scriptsEnabled = false;

            // Unfortunately, due to quirks in Firefox's networking system, we must
            // be sure to load and cache all scripts NOW before we enter the nested
            // event loop, or run the risk that some of them won't load while
            // the new event loop is nested.  It seems that the networking system
            // can't communicate with the nested loop.
            cacheAllScripts(context);

        } catch (exc) {
            // This attribute is only valid for contexts which implement nsIScriptContext.
            if (FBTrace.DBG_UI_LOOP) FBTrace.dumpProperties("debugger.stop, cacheAll exception:", exc);
        }

        try
        {
            // We will pause here until resume is called
            var depth = fbs.enterNestedEventLoop({onNest: bindFixed(this.startDebugging, this, context)});
            // For some reason we don't always end up here
            if (FBTrace.DBG_UI_LOOP) FBTrace.sysout("debugger.stop, depth:"+depth+"\n");
        }
        catch (exc)
        {
            // Just ignore exceptions that happened while in the nested loop
            if (FBTrace.DBG_ERRORS)  /*@explore*/
                FBTrace.dumpProperties("debugger exception in nested event loop: ", exc); /*@explore*/
            else     // else /*@explore*/
                ERROR("debugger exception in nested event loop: "+exc+"\n");
        }

        try {
            executionContext.scriptsEnabled = true;
        } catch (exc) {
            if (FBTrace.DBG_UI_LOOP) FBTrace.dumpProperties("debugger.stop, scriptsEnabled = true exception:", exc);
        }

        this.stopDebugging(context);

        dispatch(listeners,"onResume",[context]);

        if (this.aborted)
        {
            delete this.aborted;
            return RETURN_ABORT;
        }
        else
            return RETURN_CONTINUE;
    },

    resume: function(context)
    {
        if (FBTrace.DBG_UI_LOOP) FBTrace.sysout("debugger.resume, context.stopped:"+context.stopped+"\n");
        if (!context.stopped)
        {
            this.syncCommands(context);
            return;
        }

        delete context.stopped;
        delete context.debugFrame;
        delete context.currentFrame;
        delete context;

        var depth = fbs.exitNestedEventLoop();
        if (FBTrace.DBG_UI_LOOP) FBTrace.sysout("debugger.resume, depth:"+depth+"\n");
    },

    abort: function(context)
    {
        if (context.stopped)
        {
            context.aborted = true;
            this.resume(context);
        }
    },

    stepOver: function(context)
    {
        if (!context.debugFrame || !context.debugFrame.isValid)
            return;

        fbs.step(STEP_OVER, context.debugFrame);
        this.resume(context);
    },

    stepInto: function(context)
    {
        if (!context.debugFrame.isValid)
            return;

        fbs.step(STEP_INTO, context.debugFrame);
        this.resume(context);
    },

    stepOut: function(context)
    {
        if (!context.debugFrame.isValid)
            return;

        fbs.step(STEP_OUT, context.debugFrame);
        this.resume(context);
    },

    suspend: function(context)
    {
        if (context.stopped)
            return;
        fbs.suspend();
    },

    runUntil: function(context, sourceFile, lineNo)
    {
        if (!context.debugFrame.isValid)
            return;

        fbs.runUntil(sourceFile, lineNo, context.debugFrame, this);
        this.resume(context);
    },

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * *
    // Breakpoints

    setBreakpoint: function(sourceFile, lineNo)
    {
        fbs.setBreakpoint(sourceFile, lineNo, null, Firebug.Debugger);
    },

    clearBreakpoint: function(sourceFile, lineNo)
    {
        fbs.clearBreakpoint(sourceFile.href, lineNo);
    },

    setErrorBreakpoint: function(sourceFile, line)
    {
        fbs.setErrorBreakpoint(sourceFile, line, Firebug.Debugger);
    },

    clearErrorBreakpoint: function(sourceFile, line)
    {
        fbs.clearErrorBreakpoint(sourceFile.href, line, Firebug.Debugger);
    },

    enableErrorBreakpoint: function(sourceFile, line)
    {
        fbs.enableErrorBreakpoint(sourceFile, line, Firebug.Debugger);
    },

    disableErrorBreakpoint: function(sourceFile, line)
    {
        fbs.disableErrorBreakpoint(sourceFile, line, Firebug.Debugger);
    },

    clearAllBreakpoints: function(context)
    {
        var sourceFiles = sourceFilesAsArray(context);
        fbs.clearAllBreakpoints(sourceFiles, Firebug.Debugger);
    },

    enableAllBreakpoints: function(context)
    {
        if (FBTrace.DBG_BP)
            FBTrace.dumpProperties("enableAllBreakpoints sourceFileMap:", context.sourceFileMap);
        for (var url in context.sourceFileMap)
        {
            fbs.enumerateBreakpoints(url, {call: function(url, lineNo)
            {
                fbs.enableBreakpoint(url, lineNo);
            }});
        }
    },

    disableAllBreakpoints: function(context)
    {
        for (var url in context.sourceFileMap)
        {
            fbs.enumerateBreakpoints(url, {call: function(url, lineNo)
            {
                fbs.disableBreakpoint(url, lineNo);
            }});
        }
    },

    getBreakpointCount: function(context)
    {
        var count = 0;
        for (var url in context.sourceFileMap)
        {
            fbs.enumerateBreakpoints(url,
            {
                call: function(url, lineNo)
                {
                    ++count;
                }
            });

            fbs.enumerateErrorBreakpoints(url,
            {
                call: function(url, lineNo)
                {
                    ++count;
                }
            });
        }
        return count;
    },

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * *
    // Debugging and monitoring

    trace: function(fn, object, mode)
    {
        if (typeof(fn) == "function" || fn instanceof Function)
        {
            var script = findScriptForFunctionInContext(FirebugContext, fn);
            if (script)
                this.traceFunction(fn, script, mode);
        }
    },

    untrace: function(fn, object, mode)
    {
        if (typeof(fn) == "function" || fn instanceof Function)
        {
            var script = findScriptForFunctionInContext(FirebugContext, fn);
            if (script)
                this.untraceFunction(fn, script, mode);
        }
    },

    traceFunction: function(fn, script, mode)
    {
        var scriptInfo = getSourceFileAndLineByScript(FirebugContext, script);
        if (scriptInfo)
        {
            if (mode == "debug")
                this.setBreakpoint(scriptInfo.sourceFile, scriptInfo.lineNo, null, this);
               else if (mode == "monitor")
                fbs.monitor(scriptInfo.sourceFile, scriptInfo.lineNo, Firebug.Debugger);
        }
    },

    untraceFunction: function(fn, script, mode)
    {
        var scriptInfo = getSourceFileAndLineByScript(FirebugContext, script);
        if (scriptInfo)
        {
            if (mode == "debug")
                this.clearBreakpoint(scriptInfo.sourceFile, scriptInfo.lineNo);
            else if (mode == "monitor")
                fbs.unmonitor(scriptInfo.sourceFile, scriptInfo.lineNo);
        }
    },

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * *
    // UI Stuff

    startDebugging: function(context)
    {
        if (FBTrace.DBG_UI_LOOP) FBTrace.sysout("startDebugging enter context.stopped:"+context.stopped+" for context: "+context.window.location+"\n");                                             /*@explore*/
        try {
            fbs.lockDebugger();

            context.currentFrame = context.debugFrame;

            // Make FirebugContext = context and sync the UI
            var browser = context.browser;
            browser.chrome.showContext(browser, context);

            this.syncCommands(context);
            this.syncListeners(context);

            const updateViewOnShowHook = function()
            {
                Firebug.toggleBar(true);

                FirebugChrome.select(context.currentFrame, "script");

                var stackPanel = context.getPanel("callstack");
                if (stackPanel)
                    stackPanel.refresh(context);

                context.chrome.focus();
            }
            if ( !context.hideDebuggerUI || (FirebugChrome.getCurrentBrowser() && FirebugChrome.getCurrentBrowser().showFirebug))
                 updateViewOnShowHook();
            else {
                 context.chrome.updateViewOnShowHook = updateViewOnShowHook;
                 if (FBTrace.DBG_PANELS) FBTrace.sysout("startDebugging: set updateViewOnShowHook \n");                          /*@explore*/
            }

        }
        catch(exc)
        {
            if (FBTrace.DBG_UI_LOOP)
                FBTrace.dumpProperties("Debugger UI error during debugging loop:", exc);          /*@explore*/
            else /*@explore*/
                ERROR("Debugger UI error during debugging loop:"+exc+"\n");
        }
        if (FBTrace.DBG_UI_LOOP) FBTrace.sysout("startDebugging exit context.stopped:"+context.stopped+"\n");                                               /*@explore*/
    },

    stopDebugging: function(context)
    {
        if (FBTrace.DBG_UI_LOOP) FBTrace.sysout("stopDebugging enter context"+context+"\n");
        try
        {
            fbs.unlockDebugger();

            // If the user reloads the page while the debugger is stopped, then
            // the current context will be destroyed just before
            if (context)
            {
                var chrome = context.chrome;
                if (!chrome)
                    chrome = FirebugChrome;

                if ( chrome.updateViewOnShowHook )
                    delete chrome.updateViewOnShowHook;

                this.syncCommands(context);
                this.syncListeners(context);

                if (FirebugContext && !FirebugContext.panelName) // XXXjjb all I know is that syncSidePanels() needs this set
                    FirebugContext.panelName = "script";

                chrome.syncSidePanels();

                var panel = context.getPanel("script", true);
                if (panel)
                {
                    if (panel.executionLine)
                        panel.executionLine.removeAttribute("exeLine");
                    panel.select(null);
                }
            }
        }
        catch (exc)
        {
            if (FBTrace.DBG_UI_LOOP) FBTrace.dumpProperties("debugger.stopDebugging FAILS", exc);
            // If the window is closed while the debugger is stopped,
            // then all hell will break loose here
            ERROR(exc);
        }
    },

    syncCommands: function(context)
    {
        var chrome = context.chrome;
        if (!chrome)
        {
            if (FBTrace.DBG_ERRORS)
                FBTrace.dumpStack("debugger.syncCommand, context with no chrome: "+context.window);
            return;
        }

        if (context.stopped)
        {
            chrome.setGlobalAttribute("fbDebuggerButtons", "stopped", "true");
            chrome.setGlobalAttribute("cmd_resumeExecution", "disabled", "false");
            chrome.setGlobalAttribute("cmd_stepOver", "disabled", "false");
            chrome.setGlobalAttribute("cmd_stepInto", "disabled", "false");
            chrome.setGlobalAttribute("cmd_stepOut", "disabled", "false");
        }
        else
        {
            chrome.setGlobalAttribute("fbDebuggerButtons", "stopped", "true");
            chrome.setGlobalAttribute("cmd_resumeExecution", "disabled", "true");
            chrome.setGlobalAttribute("cmd_stepOver", "disabled", "true");
            chrome.setGlobalAttribute("cmd_stepInto", "disabled", "true");
            chrome.setGlobalAttribute("cmd_stepOut", "disabled", "true");
        }
    },

    syncListeners: function(context)
    {
        var chrome = context.chrome;
        if (!chrome)
            chrome = FirebugChrome;

        if (context.stopped)
            this.attachListeners(context, chrome);
        else
            this.detachListeners(context, chrome);
    },

    attachListeners: function(context, chrome)
    {
        this.keyListeners =
        [
            chrome.keyCodeListen("F8", null, bind(this.resume, this, context), true),
            chrome.keyListen("/", isControl, bind(this.resume, this, context)),
            chrome.keyCodeListen("F10", null, bind(this.stepOver, this, context), true),
            chrome.keyListen("'", isControl, bind(this.stepOver, this, context)),
            chrome.keyCodeListen("F11", null, bind(this.stepInto, this, context)),
            chrome.keyListen(";", isControl, bind(this.stepInto, this, context)),
            chrome.keyCodeListen("F11", isShift, bind(this.stepOut, this, context)),
            chrome.keyListen(",", isControlShift, bind(this.stepOut, this, context))
        ];
    },

    detachListeners: function(context, chrome)
    {
        if (this.keyListeners)
        {
            for (var i = 0; i < this.keyListeners.length; ++i)
                chrome.keyIgnore(this.keyListeners[i]);
            delete this.keyListeners;
        }
    },

    showPanel: function(browser, panel)
    {
        var chrome =  browser.chrome;
        if (chrome.updateViewOnShowHook)
        {
            if (FBTrace.DBG_PANELS) FBTrace.sysout("debugger.showPanel: call updateViewOnShowHook \n");                          /*@explore*/
            var updateViewOnShowHook = chrome.updateViewOnShowHook;
            delete chrome.updateViewOnShowHook;
            updateViewOnShowHook();
        }
        this.syncCommands(panel.context);
    },

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * *
    // These are XUL window level call backs and should be moved into Firebug where is says nsIFirebugClient

    onJSDActivate: function(jsd)  // just before hooks are set
    {
        // this is just to get the timing right.
        // we called by fbs as a "debuggr", (one per window) and we are re-dispatching to our listeners,
        // Firebug.DebugListeners.
        var active = this.setIsJSDActive();

        if (FBTrace.DBG_INITIALIZE)
            FBTrace.sysout("debugger.onJSDActivate "+active+"\n");

        dispatch2(listeners,"onJSDActivate",[fbs]);
    },

    onJSDDeactivate: function(jsd)
    {
        this.setIsJSDActive();
        dispatch2(listeners,"onJSDDeactivate",[fbs]);
    },

    setIsJSDActive: function()
    {
        var active = fbs.isJSDActive();
        if (active)
            $('fbStatusIcon').setAttribute("jsd", "on");
        else
            $('fbStatusIcon').setAttribute("jsd", "off");

        if (FBTrace.DBG_INITIALIZE)
            FBTrace.sysout("debugger.setIsJSDActive "+active+"\n");

        return active;
    },

    suspendFirebug: function()
    {
        Firebug.suspendFirebug();
    },

    resumeFirebug: function()
    {
        Firebug.resumeFirebug();
    },
    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * *

    supportsWindow: function(win)
    {
        var context = ( (win && TabWatcher) ? TabWatcher.getContextByWindow(win) : null);
        this.breakContext = context;
        return !!context;
    },

    supportsGlobal: function(global)
    {
        var context = (TabWatcher ? TabWatcher.getContextByWindow(global) : null);
        this.breakContext = context;
        return !!context;
    },

    onLock: function(state)
    {
        // XXXjoe For now, trying to see if it's ok to have multiple contexts
        // debugging simultaneously - otherwise we need this
        //if (this.context != this.debugContext)
        {
            // XXXjoe Disable step/continue buttons
        }
    },

    onBreak: function(frame, type)
    {
        try {
            var context = this.breakContext;
            delete this.breakContext;

            if (!context)
                context = getFrameContext(frame);
            if (!context)
                return RETURN_CONTINUE;

            return this.stop(context, frame, type);
        }
        catch (exc)
        {
            if (FBTrace.DBG_ERRORS || FBTrace.DBG_BP)
                FBTrace.dumpProperties("debugger.onBreak FAILS", exc);
            throw exc;
        }
    },

    onHalt: function(frame)
    {
        var callback = this.haltCallback;
        delete this.haltCallback;

        if (callback)
            callback(frame);

        return RETURN_CONTINUE;
    },

    onThrow: function(frame, rv)
    {
        // onThrow is called for throw and for any catch that does not succeed.
        var context = this.breakContext;
        delete this.breakContext;

        if (!context)
        {
            FBTrace.sysout("debugger.onThrow, no context, try to get from frame\n");
            context = getFrameContext(frame);
        }
        if (FBTrace.DBG_THROW) FBTrace.sysout("debugger.onThrow context:"+(context?context.window.location:"undefined")+"\n"); /*@explore*/
        if (!context)
            return RETURN_CONTINUE_THROW;

        if (!fbs.trackThrowCatch)
            return RETURN_CONTINUE_THROW;

        try
        {
            var isCatch = this.isCatchFromPreviousThrow(frame, context);
            if (!isCatch)
            {
                context.thrownStackTrace = getStackTrace(frame, context);
                if (FBTrace.DBG_THROW) FBTrace.dumpProperties("debugger.onThrow reset context.thrownStackTrace", context.thrownStackTrace.frames);
            }
            else
            {
                if (FBTrace.DBG_THROW) FBTrace.sysout("debugger.onThrow isCatch\n");
            }
        }
        catch  (exc)
        {
            ddd("onThrow FAILS: "+exc+"\n");
        }

        if (dispatch2(listeners,"onThrow",[context, frame, rv]))
            return this.stop(context, frame, TYPE_THROW, rv);
        return RETURN_CONTINUE_THROW;
    },

    isCatchFromPreviousThrow: function(frame, context)
    {
        if (context.thrownStackTrace)
        {
            var trace = context.thrownStackTrace.frames;
            if (trace.length > 1)  // top of stack is [0]
            {
                var curFrame = frame;
                var curFrameSig = curFrame.script.tag +"."+curFrame.pc;
                for (var i = 1; i < trace.length; i++)
                {
                    var preFrameSig = trace[i].signature();
                    if (FBTrace.DBG_ERRORS && FBTrace.DBG_STACK) FBTrace.sysout("debugger.isCatchFromPreviousThrow "+curFrameSig+"=="+preFrameSig+"\n");
                    if (curFrameSig == preFrameSig)
                    {
                        return true;  // catch from previous throw (or do we need to compare whole stack?
                    }
                }
                // We looked at the previous stack and did not match the current frame
            }
        }
       return false;
    },

    onCall: function(frame)
    {
        var context = this.breakContext;
        delete this.breakContext;

        if (!context)
            context = getFrameContext(frame);
        if (!context)
            return RETURN_CONTINUE;

        frame = getStackFrame(frame, context);
        Firebug.Console.log(frame, context);
    },

    onError: function(frame, error)
    {
        var context = this.breakContext;
        delete this.breakContext;

        try
        {
            Firebug.errorStackTrace = getStackTrace(frame, context);
            if (FBTrace.DBG_ERRORS) FBTrace.sysout("debugger.onError: "+error.message+"\nFirebug.errorStackTrace:\n"+traceToString(Firebug.errorStackTrace)+"\n"); /*@explore*/
            if (FBTrace.DBG_ERRORS) FBTrace.dumpProperties("debugger.onError: ",error); /*@explore*/
            if (Firebug.breakOnErrors)
                Firebug.Errors.showMessageOnStatusBar(error);
        }
        catch (exc) {
            if (FBTrace.DBG_ERRORS) FBTrace.dumpProperties("debugger.onError getStackTrace FAILED:", exc);             /*@explore*/
        }

        var hookReturn = dispatch2(listeners,"onError",[context, frame, error]);

        if (Firebug.breakOnErrors)
            return -1;  // break

        if (hookReturn)
            return hookReturn;

        return -2; /* let firebug service decide to break or not */
    },

    onEvalScriptCreated: function(frame, outerScript, innerScripts)
    {
        try
        {
            if (FBTrace.DBG_EVAL) FBTrace.sysout("debugger.onEvalLevelScript script.fileName="+outerScript.fileName+"\n");     /*@explore*/
            var context = this.breakContext;
            delete this.breakContext;

            var sourceFile = this.getEvalLevelSourceFile(frame, context, innerScripts);

            if (FBTrace.DBG_EVAL)                                                                                      /*@explore*/
            {                                                                                                          /*@explore*/
                FBTrace.sysout("debugger.onEvalScriptCreated url="+sourceFile.href+"\n");                                           /*@explore*/
                FBTrace.sysout( traceToString(FBL.getStackTrace(frame, context))+"\n" );                               /*@explore*/
            }                                                                                                          /*@explore*/

            dispatch(listeners,"onEvalScriptCreated",[context, frame, sourceFile.href]);
            return sourceFile;
        }
        catch (e)
        {
            if (FBTrace.DBG_EVAL || FBTrace.DBG_ERRORS)
                FBTrace.dumpProperties("onEvalScriptCreated FaILS ", e);
        }
    },

    onEventScriptCreated: function(frame, outerScript, innerScripts)
    {
        if (FBTrace.DBG_EVENTS) FBTrace.sysout("debugger.onEventScriptCreated script.fileName="+outerScript.fileName+"\n");     /*@explore*/
        var context = this.breakContext;
        delete this.breakContext;

        var script = frame.script;
        var creatorURL = normalizeURL(frame.script.fileName);

        try {
            var source = script.functionSource;
        } catch (exc) {
            /*Bug 426692 */
            var source = creatorURL + "/"+getUniqueId();
        }

        var url = this.getDynamicURL(frame, source, "event");

        var lines = context.sourceCache.store(url, source);
        var sourceFile = new FBL.EventSourceFile(url, frame.script, "event:"+script.functionName+"."+script.tag, lines, innerScripts);
        context.sourceFileMap[url] = sourceFile;

        if (FBTrace.DBG_EVENTS) FBTrace.sysout("debugger.onEventScriptCreated url="+sourceFile.href+"\n");   /*@explore*/

        if (FBTrace.DBG_EVENTS)                                                                                    /*@explore*/
             FBTrace.dumpProperties("debugger.onEventScriptCreated sourceFileMap:", context.sourceFileMap);                 /*@explore*/
        if (FBTrace.DBG_SOURCEFILES)                                                                               /*@explore*/
            FBTrace.sysout("debugger.onEventScriptCreated sourcefile="+sourceFile.toString()+" -> "+context.window.location+"\n");                       /*@explore*/

        dispatch(listeners,"onEventScriptCreated",[context, frame, url]);
        return sourceFile;
    },

    // We just compiled a bunch of JS, eg a script tag in HTML.  We are about to run the outerScript.
    onTopLevelScriptCreated: function(frame, outerScript, innerScripts)
    {
        if (FBTrace.DBG_TOPLEVEL) FBTrace.sysout("debugger("+this.debuggerName+").onTopLevelScriptCreated script.fileName="+outerScript.fileName+"\n");     /*@explore*/
        var context = this.breakContext;
        delete this.breakContext;

        // This is our only chance to get the linetable for the outerScript since it will run and be GC next.
        var script = frame.script;
        var url = normalizeURL(script.fileName);

        if (FBTrace.DBG_TOPLEVEL) FBTrace.sysout("debugger.onTopLevelScriptCreated outerScript.tag="+outerScript.tag+" has fileName="+outerScript.fileName+"\n"); /*@explore*/

        var sourceFile = context.sourceFileMap[url];
        if (!sourceFile)      // TODO test multiple script tags in one html file
        {
            sourceFile = new FBL.TopLevelSourceFile(url, script, script.lineExtent, innerScripts);
            context.sourceFileMap[url] = sourceFile;
            if (FBTrace.DBG_SOURCEFILES) FBTrace.sysout("debugger.onTopLevelScriptCreated create sourcefile="+sourceFile.toString()+" -> "+context.window.location+" ("+context.uid+")"+"\n"); /*@explore*/
        }
        else
        {
            if (FBTrace.DBG_SOURCEFILES) FBTrace.sysout("debugger.onTopLevelScriptCreated reuse sourcefile="+sourceFile.toString()+" -> "+context.window.location+" ("+context.uid+")"+"\n"); /*@explore*/
            FBL.addScriptsToSourceFile(sourceFile, outerScript, innerScripts);
        }

        dispatch(listeners,"onTopLevelScriptCreated",[context, frame, sourceFile.href]);
        return sourceFile;
    },


    onToggleBreakpoint: function(url, lineNo, isSet, props)
    {
        if (props.debugger != this) // then not for us
        {
            if (FBTrace.DBG_BP) FBTrace.sysout("debugger("+this.debuggerName+").onToggleBreakpoint ignoring toggle for "+(props.debugger?props.debugger.debuggerName:props.debugger)+" target "+lineNo+"@"+url+"\n"); /*@explore*/
            return;
        }

        if (FBTrace.DBG_BP) FBTrace.sysout("debugger("+this.debuggerName+").onToggleBreakpoint: "+lineNo+"@"+url+" contexts:"+TabWatcher.contexts.length+"\n");                         /*@explore*/
        for (var i = 0; i < TabWatcher.contexts.length; ++i)
        {
            var panel = TabWatcher.contexts[i].getPanel("script", true);
            if (panel)
            {
                panel.context.invalidatePanels("breakpoints");

                var sourceBox = panel.getSourceBoxByURL(url);
                if (sourceBox)
                {
                    if (FBTrace.DBG_BP)                                                                                /*@explore*/
                        FBTrace.sysout(i+") onToggleBreakpoint sourceBox.childNodes.length="+sourceBox.childNodes.length+" [lineNo-1]="+sourceBox.childNodes[lineNo-1].innerHTML+"\n"); /*@explore*/
                    var row = sourceBox.childNodes[lineNo-1];
                    row.setAttribute("breakpoint", isSet);
                    if (isSet && props)
                    {
                        row.setAttribute("condition", props.condition ? true : false);
                        row.setAttribute("disabledBreakpoint", props.disabled);
                    } else
                    {
                        row.removeAttribute("condition");
                        row.removeAttribute("disabledBreakpoint");
                    }
                }
                else
                {
                    if (FBTrace.DBG_BP) FBTrace.dumpProperties("debugger("+this.debuggerName+").onToggleBreakpoint context "+i+" script panel no sourcebox for url: "+url, panel.sourceBoxes);
                }
            }
        }
    },

    onToggleErrorBreakpoint: function(url, lineNo, isSet)
    {
        for (var i = 0; i < TabWatcher.contexts.length; ++i)
        {
            var panel = TabWatcher.contexts[i].getPanel("console", true);
            if (panel)
            {
                panel.context.invalidatePanels("breakpoints");

                for (var row = panel.panelNode.firstChild; row; row = row.nextSibling)
                {
                    var error = row.firstChild.repObject;
                    if (error instanceof ErrorMessage && error.href == url && error.lineNo == lineNo)
                    {
                        if (isSet)
                            setClass(row.firstChild, "breakForError");
                        else
                            removeClass(row.firstChild, "breakForError");
                    }
                }
            }
        }
    },

    onToggleMonitor: function(url, lineNo, isSet)
    {
        for (var i = 0; i < TabWatcher.contexts.length; ++i)
        {
            var panel = TabWatcher.contexts[i].getPanel("console", true);
            if (panel)
                panel.context.invalidatePanels("breakpoints");
        }
    },

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * *
    // XXXjjb this code is not called, because I found the scheme for detecting Function too complex.
    // I'm leaving it here to remind us that we need to support new Function().
    onFunctionConstructor: function(frame, ctor_script)
    {
       try
        {
            var context = this.breakContext;
            delete this.breakContext;

            var sourceFile = this.createSourceFileForFunctionConstructor(frame, ctor_script, context);

            if (FBTrace.DBG_EVAL)                                                                                      /*@explore*/
            {                                                                                                          /*@explore*/
                FBTrace.sysout("debugger.onFunctionConstructor tag="+ctor_script.tag+" url="+sourceFile.href+"\n");                            /*@explore*/
                FBTrace.sysout( traceToString(FBL.getStackTrace(frame, context))+"\n" );                               /*@explore*/
            }                                                                                                          /*@explore*/
                                                                                                                       /*@explore*/
            dispatch(listeners,"onFunctionConstructor",[context, frame, ctor_script, sourceFile.href]);
            return sourceFile.href;
        }
        catch(exc)
        {
            ERROR("debugger.onFunctionConstructor failed: "+exc);
            if (FBTrace.DBG_EVAL) FBTrace.dumpProperties("debugger.onFunctionConstructor failed: ",exc);                              /*@explore*/
            return null;
        }

    },

    createSourceFileForFunctionConstructor: function(caller_frame, ctor_script, context)
    {
        var ctor_expr = null; // this.getConstructorExpression(caller_frame, context);
        if (FBTrace.DBG_EVAL) FBTrace.sysout("createSourceFileForFunctionConstructor ctor_expr:"+ctor_expr+"\n");                     /*@explore*/
        if (ctor_expr)
            var source  = this.getEvalBody(caller_frame, "lib.createSourceFileForFunctionConstructor ctor_expr", 1, ctor_expr);
        else
            var source = " bah createSourceFileForFunctionConstructor"; //ctor_script.functionSource;

        if (FBTrace.DBG_EVAL) FBTrace.sysout("createSourceFileForFunctionConstructor source:"+source+"\n");                     /*@explore*/
        var url = this.getDynamicURL(frame, source, "Function");

        var lines =	context.sourceCache.store(url, source);
        var sourceFile = new FBL.FunctionConstructorSourceFile(url, caller_frame.script, ctor_expr, lines.length);
        context.sourceFileMap[url] = sourceFile;

        if (FBTrace.DBG_SOURCEFILES) FBTrace.sysout("debugger.onNewFunction sourcefile="+sourceFile.toString()+" -> "+context.window.location+"\n"); /*@explore*/

        return sourceFile;
    },

    getConstructorExpression: function(caller_frame, context)
    {
        // We believe we are just after the ctor call.
        var decompiled_lineno = getLineAtPC(caller_frame, context);
        if (FBTrace.DBG_EVAL) FBTrace.sysout("debugger.getConstructoreExpression decompiled_lineno:"+decompiled_lineno+"\n");

        var decompiled_lines = splitLines(caller_frame.script.functionSource);  // TODO place in sourceCache?
        if (FBTrace.DBG_EVAL) FBTrace.dumpProperties("debugger.getConstructoreExpression decompiled_lines:",decompiled_lines);

        var candidate_line = decompiled_lines[decompiled_lineno - 1]; // zero origin
        if (FBTrace.DBG_EVAL) FBTrace.sysout("debugger.getConstructoreExpression candidate_line:"+candidate_line+"\n");

        if (candidate_line && candidate_line != null)
            {
                var m = reFunction.exec(candidate_line);
                if (m)
                    var arguments =  m[1];     // TODO Lame: need to count parens, with escapes and quotes
            }
        if (FBTrace.DBG_EVAL) FBTrace.sysout("debugger.getConstructoreExpression arguments:"+arguments+"\n");
        if (arguments) // need to break down commas and get last arg.
        {
                var lastComma = arguments.lastIndexOf(',');
                return arguments.substring(lastComma+1);  // if -1 then 0
        }
        return null;
    },
    // end of guilt trip
    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * *

// Called by debugger.onEval() to store eval() source.
// The frame has the blank-function-name script and it is not the top frame.
// The frame.script.fileName is given by spidermonkey as file of the first eval().
// The frame.script.baseLineNumber is given by spidermonkey as the line of the first eval() call
// The source that contains the eval() call is the source of our caller.
// If our caller is a file, the source of our caller is at frame.script.baseLineNumber
// If our caller is an eval, the source of our caller is TODO Check Test Case

    getEvalLevelSourceFile: function(frame, context, innerScripts)
    {
        var eval_expr = this.getEvalExpression(frame, context);
        if (FBTrace.DBG_EVAL) FBTrace.sysout("getEvalLevelSourceFile eval_expr:"+eval_expr+"\n");                     /*@explore*/
        var source  = this.getEvalBody(frame, "lib.getEvalLevelSourceFile.getEvalBody", 1, eval_expr);
        if (FBTrace.DBG_EVAL) FBTrace.sysout("getEvalLevelSourceFile source:"+source+"\n");                     /*@explore*/

        if (context.onReadySpy)  // coool we can get the request URL.
        {
            var url = context.onReadySpy.getURL();
            if (FBTrace.DBG_EVAL || FBTrace.DBG_ERRORS)
                FBTrace.sysout("getEvalLevelSourceFile using spy URL:"+url+"\n");
        }
        else
            var url = this.getDynamicURL(frame, source, "eval");

        var lines = context.sourceCache.store(url, source);
        var sourceFile = new FBL.EvalLevelSourceFile(url, frame.script, eval_expr, lines, innerScripts);
        context.sourceFileMap[url] = sourceFile;
        if (FBTrace.DBG_SOURCEFILES) FBTrace.sysout("debugger.getEvalLevelSourceFile sourcefile="+sourceFile.toString()+" -> "+context.window.location+"\n"); /*@explore*/

        return sourceFile;
    },

    getDynamicURL: function(frame, source, kind)
    {
        var url = this.getURLFromLastLine(source);
        if (url)
            url.kind = "source";
        else
        {
            var callerURL = normalizeURL(frame.script.fileName);
            var url = this.getURLFromMD5(callerURL, source, kind);
            if (url)
                url.kind = "MD5";
            else
            {
                var url = this.getDataURLForScript(frame.script, source);
                url.kind = "data";
            }
        }

        return url;
    },

    getURLFromLastLine: function(source)
    {
        // Ignores any trailing whitespace in |source|
        const reURIinComment = /\/\/@\ssourceURL=\s*(\S*?)\s*$/m;
        var m = reURIinComment.exec(source);
        if (m)
            return m[1];
    },

    getURLFromMD5: function(callerURL, source, kind)
    {
        this.hash_service.init(this.nsICryptoHash.MD5);
        byteArray = [];
        for (var j = 0; j < source.length; j++)
        {
            byteArray.push( source.charCodeAt(j) );
        }
        this.hash_service.update(byteArray, byteArray.length);
        var hash = this.hash_service.finish(true);

        // encoding the hash should be ok, it should be information-preserving? Or at least reversable?
        var url = callerURL + (kind ? "/"+kind+"/" : "/") + encodeURIComponent(hash);

        return url;
    },

    getEvalExpression: function(frame, context)
    {
        var expr = this.getEvalExpressionFromEval(frame, context);  // eval in eval

        return (expr) ? expr : this.getEvalExpressionFromFile(normalizeURL(frame.script.fileName), frame.script.baseLineNumber, context);
    },

    getEvalExpressionFromFile: function(url, lineNo, context)
    {
        if (context && context.sourceCache)
        {
            var in_url = FBL.reJavascript.exec(url);
            if (in_url)
            {
                var m = reEval.exec(in_url[1]);
                if (m)
                    return m[1];
                else
                    return null;
            }

            var htm = reHTM.exec(url);
            if (htm) {
                lineNo = lineNo + 1; // embedded scripts seem to be off by one?  XXXjjb heuristic
            }
            // Walk backwards from the first line in the function until we find the line which
            // matches the pattern above, which is the eval call
            var line = "";
            for (var i = 0; i < 3; ++i)
            {
                line = context.sourceCache.getLine(url, lineNo-i) + line;
                if (line && line != null)
                {
                    var m = reEval.exec(line);
                    if (m)
                        return m[1];
                }
            }
        }
        return null;
    },

    getEvalExpressionFromEval: function(frame, context)
    {
        var callingFrame = frame.callingFrame;
        var sourceFile = FBL.getSourceFileByScript(context, callingFrame.script);
        if (sourceFile)
        {
            if (FBTrace.DBG_EVAL) {                                                                                    /*@explore*/
                FBTrace.sysout("debugger.getEvalExpressionFromEval sourceFile.href="+sourceFile.href+"\n");            /*@explore*/
                FBTrace.sysout("debugger.getEvalExpressionFromEval callingFrame.pc="+callingFrame.pc                   /*@explore*/
                                  +" callingFrame.script.baseLineNumber="+callingFrame.script.baseLineNumber+"\n");    /*@explore*/
            }                                                                                                          /*@explore*/
            var lineNo = callingFrame.script.pcToLine(callingFrame.pc, PCMAP_SOURCETEXT);
            lineNo = lineNo - callingFrame.script.baseLineNumber + 1;
            var url  = sourceFile.href;

            if (FBTrace.DBG_EVAL && !context.sourceCache)
                FBTrace.dumpStack("debugger.getEvalExpressionFromEval context.sourceCache null??\n");

            // Walk backwards from the first line in the function until we find the line which
            // matches the pattern above, which is the eval call
            var line = "";
            for (var i = 0; i < 3; ++i)
            {
                line = context.sourceCache.getLine(url, lineNo-i) + line;
                if (FBTrace.DBG_EVAL)                                                                                  /*@explore*/
                    FBTrace.sysout("debugger.getEvalExpressionFromEval lineNo-i="+lineNo+"-"+i+"="+(lineNo-i)+" line:"+line+"\n"); /*@explore*/
                if (line && line != null)
                {
                    var m = reEval.exec(line);
                    if (m)
                        return m[1];     // TODO Lame: need to count parens, with escapes and quotes
                }
            }
        }
        return null;
    },

    getEvalBody: function(frame, asName, asLine, evalExpr)
    {
        if (evalExpr)
        {
            var result_src = {};
            var evalThis = "new String("+evalExpr+");";
            var evaled = frame.eval(evalThis, asName, asLine, result_src);

            if (evaled)
            {
                var src = result_src.value.getWrappedValue();
                return src;
            }
            else
            {
                var source;
                if(evalExpr == "function(p,a,c,k,e,r")
                    source = "/packer/ JS compressor detected";
                else
                    source = frame.script.functionSource;
                return source+" /* !eval("+evalThis+")) */";
            }
        }
        else
        {
            return frame.script.functionSource; // XXXms - possible crash on OSX
        }
    },

    getDataURLForScript: function(script, source)
    {
        if (!source)
            return "eval."+script.tag;

        // data:text/javascript;fileName=x%2Cy.js;baseLineNumber=10,<the-url-encoded-data>
        var uri = "data:text/javascript;";
        uri += "fileName="+encodeURIComponent(script.fileName) + ";";
        uri += "baseLineNumber="+encodeURIComponent(script.baseLineNumber) + ","
        uri += encodeURIComponent(source);

        return uri;
    },

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * *
    // extends Module

    initialize: function()
    {
        this.nsICryptoHash = Components.interfaces["nsICryptoHash"];

        this.debuggerName =  window.location.href+"--"+FBL.getUniqueId(); /*@explore*/
        this.toString = function() { return this.debuggerName; } /*@explore*/
        if (FBTrace.DBG_INITIALIZE)
            FBTrace.sysout("debugger.initialize "+ this.debuggerName);

        this.hash_service = CCSV("@mozilla.org/security/hash;1", "nsICryptoHash");

        $("cmd_breakOnErrors").setAttribute("checked", Firebug.breakOnErrors);
        $("cmd_breakOnTopLevel").setAttribute("checked", Firebug.breakOnTopLevel);

        this.wrappedJSObject = this;  // how we communicate with fbs
        this.panelName = "script";
        this.description = $STR("script.modulemanager.description");

        // This is a service operation, a way of encapsulating fbs which is in turn implementing this
        // simple service. We could implment a whole component for this service, but it hardly makes sense.
        Firebug.broadcast = function encapsulateFBSBroadcast(message, args)
        {
            fbs.broadcast(message, args);
        }

        Firebug.ActivableModule.initialize.apply(this, arguments);
    },

    initializeUI: function()
    {
        Firebug.ActivableModule.initializeUI.apply(this, arguments);
        this.filterButton = $("fbScriptFilterMenu");
        this.filterMenuUpdate();
        fbs.registerClient(this);   // allow callbacks for jsd
    },

    initContext: function(context)
    {
        Firebug.ActivableModule.initContext.apply(this, arguments);
    },

    reattachContext: function(browser, context)
    {
        var chrome = context ? context.chrome : FirebugChrome;
        this.filterButton = chrome.$("fbScriptFilterMenu");  // connect to the button in the new window, not 'window'
        this.filterMenuUpdate();
        Firebug.ActivableModule.reattachContext.apply(this, arguments);
    },

    loadedContext: function(context)
    {
        if (FBTrace.DBG_SOURCEFILES) FBTrace.dumpProperties("debugger("+this.debuggerName+").loadedContext context.sourceFileMap", context.sourceFileMap);
        updateScriptFiles(context);
    },

    destroyContext: function(context)
    {
        Firebug.ActivableModule.destroyContext.apply(this, arguments);

        if (context.stopped)
        {
            TabWatcher.cancelNextLoad = true;
            this.abort(context);
        }
    },

    updateOption: function(name, value)
    {
        if (name == "breakOnErrors")
            $("cmd_breakOnErrors").setAttribute("checked", value);
        else if (name == "breakOnTopLevel")
            $("cmd_breakOnTopLevel").setAttribute("checked", value);
    },

    getObjectByURL: function(context, url)
    {
        var sourceFile = getScriptFileByHref(url, context);
        if (sourceFile)
            return new SourceLink(sourceFile.href, 0, "js");
    },

    addListener: function(listener)
    {
        listeners.push(listener);
    },

    removeListener: function(listener)
    {
        remove(listeners, listener);
    },

    shutdown: function()
    {
        fbs.unregisterDebugger(this);
        fbs.unregisterClient(this);
    },

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * *
    // extends ActivableModule
    onFirstPanelActivate: function(context, init)
    {
        fbs.registerDebugger(this);  // this will eventually set 'jsd' on the statusIcon
    },

    onPanelActivate: function(context, init, panelName)
    {
        if (panelName != this.panelName)
            return;

        if (FBTrace.DBG_STACK || FBTrace.DBG_LINETABLE || FBTrace.DBG_SOURCEFILES || FBTrace.DBG_FBS_FINDDEBUGGER) /*@explore*/
            FBTrace.sysout("debugger.onPanelActivate **************> activeContexts: "+this.activeContexts.length+" for debuggerName "+this.debuggerName+" on "+context.window.location+"\n"); /*@explore*/

        if (!init)
            context.window.location.reload();
    },

    onPanelDeactivate: function(context, destroy, panelName)
    {
        if (FBTrace.DBG_PANELS) FBTrace.sysout("debugger.onPanelDeactivate destroy: "+destroy+" for "+context.window.location+"\n");

        if (!destroy)  // then the user is saying no to debugging
            this.clearAllBreakpoints(context);
        // else the context is being torn down, possibly to reload
    },

    onLastPanelDeactivate: function(context, destroy)
    {
        if (FBTrace.DBG_STACK || FBTrace.DBG_LINETABLE || FBTrace.DBG_SOURCEFILES || FBTrace.DBG_FBS_FINDDEBUGGER) /*@explore*/
            FBTrace.sysout("debugger.onLastPanelDeactivate for "+this.debuggerName+" with destroy:"+destroy+" on"+context.window.location+"\n"); /*@explore*/

        fbs.unregisterDebugger(this);
    },

    onSuspendFirebug: function(context)
    {
        fbs.pause();  // can be called multiple times.
        var active = this.setIsJSDActive();  // update ui

        if (FBTrace.DBG_PANELS)
            FBTrace.sysout("debugger.onSuspendFirebug active:"+active+" isEnabled " +Firebug.Debugger.isEnabled(context)+ " for "+context.window.location+"\n");
    },

    onResumeFirebug: function(context)
    {
        fbs.unPause();
        var active = this.setIsJSDActive();  // update ui

        if (FBTrace.DBG_PANELS)
            FBTrace.sysout("debugger.onResumeFirebug active:"+active+" isEnabled " +Firebug.Debugger.isEnabled(context)+ " for "+context.window.location+"\n");
    },

    //---------------------------------------------------------------------------------------------
    // Menu in toolbar.

    onScriptFilterMenuTooltipShowing: function(tooltip, context)
    {
        FBTrace.dumpStack("onScriptFilterMenuTooltipShowing");
    },

    onScriptFilterMenuCommand: function(event, context)
    {
        var menu = event.target;
        Firebug.setPref("extensions.firebug-service", "scriptsFilter", menu.value);
        Firebug.Debugger.filterMenuUpdate();
    },

    menuFullLabel:
    {
        static: $STR("ScriptsFilterStatic"),
        evals: $STR("ScriptsFilterEval"),
        events: $STR("ScriptsFilterEvent"),
        all: $STR("ScriptsFilterAll"),
    },

    menuShortLabel:
    {
        static: $STR("ScriptsFilterStaticShort"),
        evals: $STR("ScriptsFilterEvalShort"),
        events: $STR("ScriptsFilterEventShort"),
        all: $STR("ScriptsFilterAllShort"),
    },

    onScriptFilterMenuPopupShowing: function(menu, context)
    {
        if (this.menuTooltip)
            this.menuTooltip.fbEnabled = false;

        var items = menu.getElementsByTagName("menuitem");
        var value = this.filterButton.value;

        for (var i=0; i<items.length; i++)
        {
            var option = items[i].value;
            if (!option)
                continue;

            if (option == value)
                items[i].setAttribute("checked", "true");

            items[i].label = Firebug.Debugger.menuFullLabel[option];
        }

        return true;
    },

    onScriptFilterMenuPopupHiding: function(tooltip, context)
    {
        if (this.menuTooltip)
            this.menuTooltip.fbEnabled = true;

        return true;
    },

    filterMenuUpdate: function()
    {
        var value = Firebug.getPref("extensions.firebug-service", "scriptsFilter");
        this.filterButton.value = value;
        this.filterButton.label = this.menuShortLabel[value];
        this.filterButton.removeAttribute("disabled");
        this.filterButton.setAttribute("value", value);
        FBTrace.sysout("debugger.filterMenuUpdate value: "+value+" label:"+this.filterButton.label+'\n');
    },

    //----------------------------------------------------------------------------------

});


// ************************************************************************************************

function ScriptPanel() {}

ScriptPanel.prototype = extend(Firebug.SourceBoxPanel,
{

    updateSourceBox: function(sourceBox)
    {
        if (this.executionFile && this.location.href == this.executionFile.href)
            this.setExecutionLine(this.executionLineNo);

        var self = this;
        setTimeout( function delayMarkRevealedLines() {
            self.markRevealedLines(sourceBox);
        });
    },

    getSourceType: function()
    {
        return "js";
    },

    showFunction: function(fn)
    {
        var sourceLink = findSourceForFunction(fn, this.context);
        if (sourceLink)
        {
            this.showSourceLink(sourceLink);
        }
        else
        {
            if (FBTrace.DBG_ERRORS) FBTrace.dumpStack("no sourcelink for function"); // want to avoid the debugger panel if possible
        }
    },

    showSourceLink: function(sourceLink)
    {
        var sourceFile = getScriptFileByHref(sourceLink.href, this.context);
        if (sourceFile)
        {
            this.navigate(sourceFile);
            if (sourceLink.line)
                this.scrollToLine(sourceLink.line, true);
        }
    },

    showStackFrame: function(frame)
    {
        this.context.currentFrame = frame;

        if (!frame || (frame && !frame.isValid))
        {
            if (FBTrace.DBG_STACK) FBTrace.sysout("showStackFrame no valid frame\n");
            this.showNoStackFrame();
            return;
        }

        this.executionFile = FBL.getSourceFileByScript(this.context, frame.script);
        if (this.executionFile)
        {
            var url = this.executionFile.href;
            var analyzer = this.executionFile.getScriptAnalyzer(frame.script);
            this.executionLineNo = analyzer.getSourceLineFromFrame(this.context, frame);  // TODo implement for each type
               if (FBTrace.DBG_STACK) FBTrace.sysout("showStackFrame executionFile:"+this.executionFile+"@"+this.executionLineNo+"\n"); /*@explore*/

            this.navigate(this.executionFile);
            this.context.throttle(this.setExecutionLine, this, [this.executionLineNo]);
            this.context.throttle(this.updateInfoTip, this);
            return;
        }
        else
        {
            if (FBTrace.DBG_STACK) FBTrace.sysout("showStackFrame no getSourceFileByScript for tag="+frame.script.tag+"\n");                                    /*@explore*/
            this.showNoStackFrame();
        }
    },

    showNoStackFrame: function()
    {
        this.executionFile = null;
        this.executionLineNo = -1;
        this.setExecutionLine(-1);
        this.updateInfoTip();
    },

    markExecutableLines: function(sourceBox, min, max)
    {
        var sourceFile = sourceBox.repObject;
        if (FBTrace.DBG_BP || FBTrace.DBG_LINETABLE) FBTrace.sysout("debugger.markExecutableLines START: "+sourceFile.toString()+"\n");                /*@explore*/
        var lineNo = min ? min : 1;
        while( lineNode = this.getLineNode(lineNo) )
        {
            var checked = lineNode.getAttribute("exeChecked");
            if (!checked)
            {
                var scripts = sourceFile.scriptsIfLineCouldBeExecutable(lineNo, true);

                if (FBTrace.DBG_LINETABLE) FBTrace.sysout("debugger.markExecutableLines ["+lineNo+"]= "+(scripts?scripts.length+" scripts":"(none)")+"\n");
                if (scripts)
                    lineNode.setAttribute("executable", "true");
                else
                    lineNode.removeAttribute("executable");

                lineNode.setAttribute("exeChecked", "true");
            }
            lineNo++;
            if (max && lineNo > max) break;
        }
        if (FBTrace.DBG_BP || FBTrace.DBG_LINETABLE) FBTrace.sysout("debugger.markExecutableLines DONE: "+sourceFile.toString()+"\n");                /*@explore*/
    },

    selectLine: function(lineNo)  // never called
    {
        var lineNode = this.getLineNode(lineNo);
        if (lineNode)
        {
            var selection = this.document.defaultView.getSelection();
            selection.selectAllChildren(lineNode);
        }
    },

    setExecutionLine: function(lineNo)  // TODO should be in showSourceFile callback
    {
        var lineNode = (lineNo == -1) ? null : this.getLineNode(lineNo);
        if (lineNode)
            this.scrollToLine(lineNo);

        if (this.executionLine)
            this.executionLine.removeAttribute("exeLine");

        this.executionLine = lineNode;

        if (lineNode)
            lineNode.setAttribute("exeLine", "true");
                                                                                                                       /*@explore*/
        if (FBTrace.DBG_BP || FBTrace.DBG_STACK) FBTrace.sysout("debugger.setExecutionLine to lineNo: "+lineNo+" lineNode="+lineNode+"\n"); /*@explore*/
    },

    toggleBreakpoint: function(lineNo)
    {
        var lineNode = this.getLineNode(lineNo);
        if (FBTrace.DBG_BP) FBTrace.sysout("debugger.toggleBreakpoint lineNo="+lineNo+" this.location.href:"+this.location.href+" lineNode.breakpoint:"+(lineNode?lineNode.getAttribute("breakpoint"):"(no lineNode)")+"\n");                           /*@explore*/
        if (lineNode.getAttribute("breakpoint") == "true")
            fbs.clearBreakpoint(this.location.href, lineNo);
        else
            fbs.setBreakpoint(this.location, lineNo, null, Firebug.Debugger);
    },

    toggleDisableBreakpoint: function(lineNo)
    {
        var lineNode = this.getLineNode(lineNo);
        if (lineNode.getAttribute("disabledBreakpoint") == "true")
            fbs.enableBreakpoint(this.location.href, lineNo);
        else
            fbs.disableBreakpoint(this.location.href, lineNo);
    },

    editBreakpointCondition: function(lineNo)
    {
        var sourceRow = this.getLineNode(lineNo);
        var sourceLine = getChildByClass(sourceRow, "sourceLine");
        var condition = fbs.getBreakpointCondition(this.location.href, lineNo);

        Firebug.Editor.startEditing(sourceLine, condition);
    },

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * *

    addSelectionWatch: function()
    {
        var watchPanel = this.context.getPanel("watches", true);
        if (watchPanel)
        {
            var selection = this.document.defaultView.getSelection().toString();
            watchPanel.addWatch(selection);
        }
    },

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * *

    updateInfoTip: function()
    {
        var infoTip = this.panelBrowser.infoTip;
        if (infoTip && this.infoTipExpr)
            this.populateInfoTip(infoTip, this.infoTipExpr);
    },

    populateInfoTip: function(infoTip, expr)
    {
        if (!expr || isJavaScriptKeyword(expr))
            return false;

        var self = this;
        // If the evaluate fails, then we report an error and don't show the infoTip
        Firebug.CommandLine.evaluate(expr, this.context, null, this.context.window,
            function success(result, context)
            {
                var rep = Firebug.getRep(result);
                var tag = rep.shortTag ? rep.shortTag : rep.tag;

                tag.replace({object: result}, infoTip);

                self.infoTipExpr = expr;
            },
            function failed(result, context)
            {
                self.infoTipExpr = "";
            }
        );
        return (self.infoTipExpr == expr);
    },

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * *
    // UI event listeners

    onMouseDown: function(event)
    {
        var sourceLine = getAncestorByClass(event.target, "sourceLine");
        if (!sourceLine)
            return;

        var sourceRow = sourceLine.parentNode;
        var sourceFile = sourceRow.parentNode.repObject;
        var lineNo = parseInt(sourceLine.textContent);

        if (isLeftClick(event))
            this.toggleBreakpoint(lineNo);
        else if (isShiftClick(event))
            this.toggleDisableBreakpoint(lineNo);
        else if (isControlClick(event) || isMiddleClick(event))
        {
            Firebug.Debugger.runUntil(this.context, sourceFile, lineNo, Firebug.Debugger);
            cancelEvent(event);
        }
    },

    onContextMenu: function(event)
    {
        var sourceLine = getAncestorByClass(event.target, "sourceLine");
        if (!sourceLine)
            return;

        var lineNo = parseInt(sourceLine.textContent);
        this.editBreakpointCondition(lineNo);
        cancelEvent(event);
    },

    onMouseOver: function(event)
    {
        var sourceLine = getAncestorByClass(event.target, "sourceLine");
        if (sourceLine)
        {
            if (this.hoveredLine)
                removeClass(this.hoveredLine.parentNode, "hovered");

            this.hoveredLine = sourceLine;

            if (sourceLine)
                setClass(sourceLine.parentNode, "hovered");
        }
    },

    onMouseOut: function(event)
    {
        var sourceLine = getAncestorByClass(event.relatedTarget, "sourceLine");
        if (!sourceLine)
        {
            if (this.hoveredLine)
                removeClass(this.hoveredLine.parentNode, "hovered");

            delete this.hoveredLine;
        }
    },

    onScroll: function(event)
    {
        var scrollingElement = event.target;
        this.markRevealedLines(scrollingElement);
    },

    markRevealedLines: function(scrollingElement)
    {
        if (!this.lastScrollTop)
            this.lastScrollTop = 0;

        var scrollTop = scrollingElement.scrollTop;
        if (!scrollTop)
            scrollTop = 0;

        var aLineNode = this.getLineNode(1);
        if (!aLineNode)
        {
            if (FBTrace.DBG_LINETABLE) FBTrace.dumpStack("debugger.markRevealedLines: no line node\n");
            return;
        }
        var scrollStep = aLineNode.offsetHeight;
        if (!scrollStep || scrollStep < 1) // then not rendered yet
        {
            if (FBTrace.DBG_LINETABLE)
            {
                FBTrace.dumpStack("debugger.markRevealedLines: no offsetHeight", aLineNode);
                FBTrace.dumpProperties("debugger.markRevealedLines: no offsetHeight", aLineNode);
            }
            min = 1;
            max = 20;
        }
        else
        {

            var lastTopLine = Math.round(this.lastScrollTop/scrollStep + 1);
            var lastBottomLine = Math.round((this.lastScrollTop + scrollingElement.clientHeight)/scrollStep);

            var newTopLine = Math.round(scrollTop/scrollStep + 1);
            var newBottomLine = Math.round((scrollTop + scrollingElement.clientHeight)/scrollStep);

            var delta = this.lastScrollTop - scrollTop;
            if (delta < 0) // then we exposed a line at the bottom
            {
                var min = newTopLine;
                if (min < lastBottomLine)
                    min = lastBottomLine;
                var max = newBottomLine;
            }
            else if (delta > 0)
            {
                var min = newTopLine;
                var max = newBottomLine;
                if (max > lastTopLine)
                    max = lastTopLine;
            }
            else  // delta = 0
            {
                var min = newTopLine;
                var max = newBottomLine;
            }

            if (FBTrace.DBG_LINETABLE)
            {
                FBTrace.sysout("debugger.markRevealedLines scrollTop: "+scrollTop, " lastScrollTop:"+this.lastScrollTop);
                FBTrace.sysout("debugger.markRevealedLines lastTopLine:"+lastTopLine, "lastBottomLine: "+lastBottomLine);
                FBTrace.sysout("debugger.markRevealedLines newTopLine:"+newTopLine, "newBottomLine: "+newBottomLine);
            }
        }
        this.lastScrollTop = scrollTop;

        this.markVisible(min, max);
    },

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * *
    // extends Panel

    name: "script",
    searchable: true,

    initialize: function(context, doc)
    {
        this.onMouseDown = bind(this.onMouseDown, this);
        this.onContextMenu = bind(this.onContextMenu, this);
        this.onMouseOver = bind(this.onMouseOver, this);
        this.onMouseOut = bind(this.onMouseOut, this);
        this.onScroll = bind(this.onScroll, this);
        this.setLineBreakpoints = bind(setLineBreakpoints, this);

        this.panelSplitter = $("fbPanelSplitter");
        this.sidePanelDeck = $("fbSidePanelDeck");

        Firebug.Panel.initialize.apply(this, arguments);
    },

    destroy: function(state)
    {
        persistObjects(this, state);

        var sourceBox = this.selectedSourceBox;
        state.lastScrollTop = sourceBox  && sourceBox.scrollTop
            ? sourceBox.scrollTop
            : this.lastScrollTop;

        delete this.selectedSourceBox;

        Firebug.Panel.destroy.apply(this, arguments);
    },

    detach: function(oldChrome, newChrome)
    {
        if (this.selectedSourceBox)
            this.lastSourceScrollTop = this.selectedSourceBox.scrollTop;

        if (this.context.stopped)
        {
            Firebug.Debugger.detachListeners(this.context, oldChrome);
            Firebug.Debugger.attachListeners(this.context, newChrome);
        }

        Firebug.Debugger.syncCommands(this.context);

        Firebug.Panel.detach.apply(this, arguments);
    },

    reattach: function(doc)
    {
        Firebug.Panel.reattach.apply(this, arguments);

        setTimeout(bind(function()
        {
            this.selectedSourceBox.scrollTop = this.lastSourceScrollTop;
            delete this.lastSourceScrollTop;
        }, this));
    },

    initializeNode: function(oldPanelNode)
    {
        this.tooltip = this.document.createElement("div");
        setClass(this.tooltip, "scriptTooltip");
        obscure(this.tooltip, true);
        this.panelNode.appendChild(this.tooltip);

        this.initializeSourceBoxes();

        this.panelNode.addEventListener("mousedown", this.onMouseDown, true);
        this.panelNode.addEventListener("contextmenu", this.onContextMenu, false);
        this.panelNode.addEventListener("mouseover", this.onMouseOver, false);
        this.panelNode.addEventListener("mouseout", this.onMouseOut, false);
        this.panelNode.addEventListener("DOMMouseScroll", this.onScroll, false);
        this.panelNode.addEventListener("scroll", this.onScroll, true);
    },

    destroyNode: function()
    {
        if (this.tooltipTimeout)
            clearTimeout(this.tooltipTimeout);

        this.panelNode.removeEventListener("mousedown", this.onMouseDown, true);
        this.panelNode.removeEventListener("contextmenu", this.onContextMenu, false);
        this.panelNode.removeEventListener("mouseover", this.onMouseOver, false);
        this.panelNode.removeEventListener("mouseout", this.onMouseOut, false);
        this.panelNode.removeEventListener("DOMMouseScroll", this.onScroll, false);
        this.panelNode.removeEventListener("scroll", this.onScroll, true);
    },

    clear: function()
    {
        clearNode(this.panelNode);
    },

    show: function(state)
    {
        var enabled = Firebug.Debugger.isEnabled(this.context);

        // The "enable/disable" button is always visible.
        this.showToolbarButtons("fbScriptButtons", true);

        // static scripts can be shown
        this.showToolbarButtons("fbLocationList", true);

        // These buttons are visible only if debugger is enabled.
        this.showToolbarButtons("fbLocationSeparator", enabled);
        this.showToolbarButtons("fbDebuggerButtons", enabled);

        this.obeyPreferences();

        // The default page with description and enable button is
        // visible only if debugger is disabled.
        if (enabled)
            Firebug.ModuleManagerPage.hide(this);
        else
            Firebug.ModuleManagerPage.show(this, Firebug.Debugger);

        // Additional debugger panels are visible only if debugger
        // is enabled.
        this.panelSplitter.collapsed = !enabled;
        this.sidePanelDeck.collapsed = !enabled;

        // Source box is updated only if debugger is enabled.
        if (enabled && !this.location)
        {
            restoreObjects(this, state);

            if (state)
            {
                this.context.throttle(function()
                {
                    var sourceBox = this.selectedSourceBox;
                    if (sourceBox)
                        sourceBox.scrollTop = state.lastScrollTop;
                }, this);
            }

            var breakpointPanel = this.context.getPanel("breakpoints", true);
            if (breakpointPanel)
                breakpointPanel.refresh();
        }
    },

    obeyPreferences: function()
    {
        if (Firebug.omitObjectPathStack)  // User does not want the toolbar stack
            FBL.hide(panelStatus, true);
    },

    hide: function()
    {
        this.showToolbarButtons("fbDebuggerButtons", false);
        this.showToolbarButtons("fbScriptButtons", false);
        FBL.hide(panelStatus, false);

        delete this.infoTipExpr;

        var sourceBox = this.selectedSourceBox;
        if (sourceBox)
            this.lastScrollTop = sourceBox.scrollTop;
    },

    search: function(text)
    {
        var sourceBox = this.selectedSourceBox;
        if (!text || !sourceBox)
        {
            delete this.currentSearch;
            return false;
        }

        // Check if the search is for a line number
        var m = reLineNumber.exec(text);
        if (m)
        {
            if (!m[1])
                return true; // Don't beep if only a # has been typed

            var lineNo = parseInt(m[1]);
            if (this.highlightLine(lineNo))
                return true;
        }

        var row;
        if (this.currentSearch && text == this.currentSearch.text)
            row = this.currentSearch.findNext(true);
        else
        {
            function findRow(node) { return getAncestorByClass(node, "sourceRow"); }
            this.currentSearch = new TextSearch(sourceBox, findRow);
            row = this.currentSearch.find(text);
        }

        if (row)
        {
            var sel = this.document.defaultView.getSelection();
            sel.removeAllRanges();
            sel.addRange(this.currentSearch.range);

            scrollIntoCenterView(row, sourceBox);
            return true;
        }
        else
            return false;
    },

    supportsObject: function(object)
    {
        if( object instanceof jsdIStackFrame
            || object instanceof SourceFile
            || (object instanceof SourceLink && object.type == "js")
            || typeof(object) == "function" )
            return 1;
        else return 0;
    },

    updateLocation: function(sourceFile)
    {
        if (!Firebug.Debugger.isEnabled(this.context))
            Firebug.ModuleManagerPage.hide(this);

        // Since our last use of the sourceFile we may have compiled or recompiled the source
        var updatedSourceFile = this.context.sourceFileMap[sourceFile.href];
        if (!updatedSourceFile)
            updatedSourceFile = this.getDefaultLocation(this.context);
        if (!updatedSourceFile)
            return;

        this.showSourceFile(updatedSourceFile, this.setLineBreakpoints);
    },

    updateSelection: function(object)
    {
        if (FBTrace.DBG_PANELS) FBTrace.sysout("debugger updateSelection object:"+object+"\n");
        if (object instanceof jsdIStackFrame)
            this.showStackFrame(object);
        else if (object instanceof SourceFile)
            this.navigate(object);
        else if (object instanceof SourceLink)
            this.showSourceLink(object);
        else if (typeof(object) == "function")
            this.showFunction(object);
        else
            this.showStackFrame(null);
    },

    showThisSourceFile: function(sourceFile)
    {
        //-----------------------------------123456789
        if (sourceFile.href.substr(0, 9) == "chrome://")
            return false;

           if (sourceFile.isEval() && !this.showEvals)
               return false;

        if (sourceFile.isEvent() && !this.showEvents)
            return false;

        return true;
    },

    getLocationList: function()
    {
        var context = this.context;
        var allSources = sourceFilesAsArray(context);

        if (Firebug.showAllSourceFiles)
        {
            if (FBTrace.DBG_SOURCEFILES) FBTrace.dumpProperties("debugger getLocationList "+context.window.location+" allSources", allSources); /*@explore*/
            return allSources;
        }

        var filter = Firebug.getPref("extensions.firebug-service", "scriptsFilter");
        this.showEvents = (filter == "all" || filter == "events");
        this.showEvals = (filter == "all" || filter == "evals");

        var list = [];
        for (var i = 0; i < allSources.length; i++)
        {
            if (this.showThisSourceFile(allSources[i]))
                list.push(allSources[i]);
        }

        if (FBTrace.DBG_SOURCEFILES) FBTrace.dumpProperties("debugger.getLocationList BEFORE iterateWindows ", list); /*@explore*/

       iterateWindows(context.window, function(win) {
            if (FBTrace.DBG_SOURCEFILES)                                                                                                /*@explore*/
                FBTrace.sysout("getLocationList iterateWindows: "+win.location.href, " documentElement: "+win.document.documentElement);  /*@explore*/
            if (!win.document.documentElement)
                return;
            var url = win.location.href;
            if (url)
            {
                if (context.sourceFileMap.hasOwnProperty(url))
                    return;
                list.push(new NoScriptSourceFile(context, url));
                if (FBTrace.DBG_SOURCEFILES) FBTrace.sysout("debugger.getLocationList created NoScriptSourceFile for URL:"+url);
            }
        });
        if (FBTrace.DBG_SOURCEFILES) FBTrace.dumpProperties("debugger.getLocationList ", list); /*@explore*/
        return list;
    },

    getDefaultLocation: function(context)
    {
        var sourceFiles = this.getLocationList();
        if (context)
        {
            var url = context.window.location.toString();
            for (var i = 0; i < sourceFiles.length; i++)
            {
                if (url == sourceFiles[i].href)
                    return sourceFiles[i];
            }
        }
        else
            return sourceFiles[0];
    },

    getDefaultSelection: function(context)
    {
        return this.getDefaultLocation(context);
    },

    getTooltipObject: function(target)
    {
        // Target should be A element with class = sourceLine
        if ( hasClass(target, 'sourceLine') )
        {
            var lineNo = parseInt(target.innerHTML);

            if ( isNaN(lineNo) )
                return;
            var scripts = this.location.scriptsIfLineCouldBeExecutable(lineNo);
            if (scripts)
            {
                var str = "scripts ";
                for(var i = 0; i < scripts.length; i++)
                    str += scripts[i].tag +" ";
                return str;
            }
            else
                return new String("no executable script at "+lineNo);
        }
        return null;
    },

    getPopupObject: function(target)
    {
        // Don't show popup over the line numbers, we show the conditional breakpoint
        // editor there instead
        var sourceLine = getAncestorByClass(target, "sourceLine");
        if (sourceLine)
            return;

        var sourceRow = getAncestorByClass(target, "sourceRow");
        if (!sourceRow)
            return;

        var lineNo = parseInt(sourceRow.firstChild.textContent);
        var scripts = findScripts(this.context, this.location.href, lineNo);
        return scripts; // gee I wonder what will happen?
    },

    showInfoTip: function(infoTip, target, x, y, rangeParent, rangeOffset)
    {
        var frame = this.context.currentFrame;
        if (!frame)
            return;

        var sourceRowText = getAncestorByClass(target, "sourceRowText");
        if (!sourceRowText)
            return;

        // see http://code.google.com/p/fbug/issues/detail?id=889
        // idea from: Jonathan Zarate's rikaichan extension (http://www.polarcloud.com/rikaichan/)
        if (!rangeParent)
            return;
        rangeOffset = rangeOffset || 0;
        var expr = getExpressionAt(rangeParent.data, rangeOffset);
        if (!expr || !expr.expr)
            return;

        if (expr.expr == this.infoTipExpr)
            return true;
        else
            return this.populateInfoTip(infoTip, expr.expr);
    },

    getObjectPath: function(frame)
    {
        frame = this.context.debugFrame;

        var frames = [];
        for (; frame; frame = getCallingFrame(frame))
            frames.push(frame);

        return frames;
    },

    getObjectLocation: function(sourceFile)
    {
        return sourceFile.href;
    },

    // return.path: group/category label, return.name: item label
    getObjectDescription: function(sourceFile)
    {
        return sourceFile.getObjectDescription();
    },

    getOptionsMenuItems: function()
    {
        var context = this.context;

        return [
            serviceOptionMenu("BreakOnAllErrors", "breakOnErrors"),
            // wait 1.2 optionMenu("BreakOnTopLevel", "breakOnTopLevel"),
            serviceOptionMenu("ShowAllSourceFiles", "showAllSourceFiles"),
            // 1.2: always check last line; optionMenu("UseLastLineForEvalName", "useLastLineForEvalName"),
            // 1.2: always use MD5 optionMenu("UseMD5ForEvalName", "useMD5ForEvalName")
            serviceOptionMenu("TrackThrowCatch", "trackThrowCatch"),
            //"-",
            //1.2 option on toolbar this.optionMenu("DebuggerEnableAlways", enableAlwaysPref)
        ];
    },

    optionMenu: function(label, option)
    {
        var checked = Firebug.getPref(prefDomain, option);
        return {label: label, type: "checkbox", checked: checked,
            command: bindFixed(Firebug.setPref, Firebug, prefDomain, option, !checked) };
    },

    getContextMenuItems: function(fn, target)
    {
        if (getAncestorByClass(target, "sourceLine"))
            return;

        var sourceRow = getAncestorByClass(target, "sourceRow");
        if (!sourceRow)
            return;

        var sourceLine = getChildByClass(sourceRow, "sourceLine");
        var lineNo = parseInt(sourceLine.textContent);

        var items = [];

        var selection = this.document.defaultView.getSelection();
        if (selection.toString())
        {
            items.push(
                "-",
                {label: "AddWatch", command: bind(this.addSelectionWatch, this) }
            );
        }

        var hasBreakpoint = sourceRow.getAttribute("breakpoint") == "true";

        items.push(
            "-",
            {label: "SetBreakpoint", type: "checkbox", checked: hasBreakpoint,
                command: bindFixed(this.toggleBreakpoint, this, lineNo) }
        );
        if (hasBreakpoint)
        {
            var isDisabled = fbs.isBreakpointDisabled(this.location.href, lineNo);
            items.push(
                {label: "DisableBreakpoint", type: "checkbox", checked: isDisabled,
                    command: bindFixed(this.toggleDisableBreakpoint, this, lineNo) }
            );
        }
        items.push(
            {label: "EditBreakpointCondition",
                command: bindFixed(this.editBreakpointCondition, this, lineNo) }
        );

        if (this.context.stopped)
        {
            var sourceRow = getAncestorByClass(target, "sourceRow");
            if (sourceRow)
            {
                var sourceFile = sourceRow.parentNode.repObject;
                var lineNo = parseInt(sourceRow.firstChild.textContent);

                var debuggr = Firebug.Debugger;
                items.push(
                    "-",
                    {label: "Continue",
                        command: bindFixed(debuggr.resume, debuggr, this.context) },
                    {label: "StepOver",
                        command: bindFixed(debuggr.stepOver, debuggr, this.context) },
                    {label: "StepInto",
                        command: bindFixed(debuggr.stepInto, debuggr, this.context) },
                    {label: "StepOut",
                        command: bindFixed(debuggr.stepOut, debuggr, this.context) },
                    {label: "RunUntil",
                        command: bindFixed(debuggr.runUntil, debuggr, this.context,
                        sourceFile, lineNo) }
                );
            }
        }

        return items;
    },

    getEditor: function(target, value)
    {
        if (!this.conditionEditor)
            this.conditionEditor = new ConditionEditor(this.document);

        return this.conditionEditor;
    },

});

// ************************************************************************************************

var BreakpointsTemplate = domplate(Firebug.Rep,
{
    tag:
        DIV({onclick: "$onClick"},
            FOR("group", "$groups",
                DIV({class: "breakpointBlock breakpointBlock-$group.name"},
                    H1({class: "breakpointHeader groupHeader"},
                        "$group.title"
                    ),
                    FOR("bp", "$group.breakpoints",
                        DIV({class: "breakpointRow"},
                            DIV({class: "breakpointBlockHead"},
                                INPUT({class: "breakpointCheckbox", type: "checkbox",
                                    _checked: "$bp.checked"}),
                                SPAN({class: "breakpointName"}, "$bp.name"),
                                TAG(FirebugReps.SourceLink.tag, {object: "$bp|getSourceLink"}),
                                IMG({class: "closeButton", src: "blank.gif"})
                            ),
                            DIV({class: "breakpointCode"}, "$bp.sourceLine")
                        )
                    )
                )
            )
        ),

    getSourceLink: function(bp)
    {
        return new SourceLink(bp.href, bp.lineNumber, "js");
    },

    onClick: function(event)
    {
        var panel = Firebug.getElementPanel(event.target);

        if (getAncestorByClass(event.target, "breakpointCheckbox"))
        {
            var sourceLink =
                getElementByClass(event.target.parentNode, "objectLink-sourceLink").repObject;

            panel.noRefresh = true;
            if (event.target.checked)
                fbs.enableBreakpoint(sourceLink.href, sourceLink.line);
            else
                fbs.disableBreakpoint(sourceLink.href, sourceLink.line);
            panel.noRefresh = false;
        }
        else if (getAncestorByClass(event.target, "closeButton"))
        {
            var sourceLink =
                getElementByClass(event.target.parentNode, "objectLink-sourceLink").repObject;

            panel.noRefresh = true;

            var head = getAncestorByClass(event.target, "breakpointBlock");
            var groupName = getClassValue(head, "breakpointBlock");
            if (groupName == "breakpoints")
                fbs.clearBreakpoint(sourceLink.href, sourceLink.line);
            else if (groupName == "errorBreakpoints")
                fbs.clearErrorBreakpoint(sourceLink.href, sourceLink.line);
            else if (groupName == "monitors")
            {
                fbs.unmonitor(sourceLink.href, sourceLink.line)
            }

            var row = getAncestorByClass(event.target, "breakpointRow");
            panel.removeRow(row);

            panel.noRefresh = false;
        }
    }
});

// ************************************************************************************************

function BreakpointsPanel() {}

BreakpointsPanel.prototype = extend(Firebug.Panel,
{
    removeRow: function(row)
    {
        row.parentNode.removeChild(row);

        var bpCount = countBreakpoints(this.context);
        if (!bpCount)
            this.refresh();
    },

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * *
    // extends Panel

    name: "breakpoints",
    parentPanel: "script",
    order: 2,

    initialize: function()
    {
        Firebug.Panel.initialize.apply(this, arguments);
    },

    destroy: function(state)
    {
        Firebug.Panel.destroy.apply(this, arguments);
    },

    show: function(state)
    {
        this.refresh();
    },

    refresh: function()
    {
        updateScriptFiles(this.context);

        var breakpoints = [];
        var errorBreakpoints = [];
        var monitors = [];

        var context = this.context;

        for (var url in this.context.sourceFileMap)
        {
            fbs.enumerateBreakpoints(url, {call: function(url, line, script, props)
            {
                if (script)  // then this is a current (not future) breakpoint
                {
                    var analyzer = getScriptAnalyzer(context, script);
                    if (FBTrace.DBG_BP) FBTrace.sysout("debugger.refresh enumerateBreakpoints for script="+script.tag+(analyzer?" has analyzer":" no analyzer")+"\n"); /*@explore*/

                    if (analyzer)
                        var name = analyzer.getFunctionDescription(script, context).name;
                    else
                        var name = guessFunctionName(url, 1, context);
                    var isFuture = false;
                }
                else
                {
                    if (FBTrace.DBG_BP) FBTrace.sysout("debugger.refresh enumerateBreakpoints future for url@line="+url+"@"+line+"\n"); /*@explore*/
                    var isFuture = true;
                }

                var source = context.sourceCache.getLine(url, line);
                breakpoints.push({name : name, href: url, lineNumber: line,
                    checked: !props.disabled, sourceLine: source, isFuture: isFuture});
            }});

            fbs.enumerateErrorBreakpoints(url, {call: function(url, line)
            {
                var name = guessEnclosingFunctionName(url, line);
                var source = context.sourceCache.getLine(url, line);
                errorBreakpoints.push({name: name, href: url, lineNumber: line, checked: true,
                    sourceLine: source});
            }});

            fbs.enumerateMonitors(url, {call: function(url, line)
            {
                var name = guessEnclosingFunctionName(url, line);
                monitors.push({name: name, href: url, lineNumber: line, checked: true,
                        sourceLine: ""});
            }});
        }

        function sortBreakpoints(a, b)
        {
            if (a.href == b.href)
                return a.lineNumber < b.lineNumber ? -1 : 1;
            else
                return a.href < b.href ? -1 : 1;
        }

        breakpoints.sort(sortBreakpoints);
        errorBreakpoints.sort(sortBreakpoints);
        monitors.sort(sortBreakpoints);

        var groups = [];

        if (breakpoints.length)
            groups.push({name: "breakpoints", title: $STR("Breakpoints"),
                breakpoints: breakpoints});
        if (errorBreakpoints.length)
            groups.push({name: "errorBreakpoints", title: $STR("ErrorBreakpoints"),
                breakpoints: errorBreakpoints});
        if (monitors.length)
            groups.push({name: "monitors", title: $STR("LoggedFunctions"),
                breakpoints: monitors});

        if (groups.length)
            BreakpointsTemplate.tag.replace({groups: groups}, this.panelNode);
        else
            FirebugReps.Warning.tag.replace({object: "NoBreakpointsWarning"}, this.panelNode);

    },

    getOptionsMenuItems: function()
    {
        var items = [];

        var context = this.context;
        updateScriptFiles(context);

        var bpCount = 0, disabledCount = 0;
        for (var url in context.sourceFileMap)
        {
            fbs.enumerateBreakpoints(url, {call: function(url, line, script, disabled, condition)
            {
                ++bpCount;
                if (fbs.isBreakpointDisabled(url, line))
                    ++disabledCount;
            }});
        }

        if (disabledCount)
        {
            items.push(
                {label: "EnableAllBreakpoints",
                    command: bindFixed(
                        Firebug.Debugger.enableAllBreakpoints, Firebug.Debugger, context) }
            );
        }
        if (bpCount && disabledCount != bpCount)
        {
            items.push(
                {label: "DisableAllBreakpoints",
                    command: bindFixed(
                        Firebug.Debugger.disableAllBreakpoints, Firebug.Debugger, context) }
            );
        }

        items.push(
            "-",
            {label: "ClearAllBreakpoints", disabled: !bpCount,
                command: bindFixed(Firebug.Debugger.clearAllBreakpoints, Firebug.Debugger, context) }
        );

        return items;
    },

});

Firebug.DebuggerListener =
{
    onJSDActivate: function(jsd)  // start or unPause
    {

    },
    onJSDDeactivate: function(jsd) // stop or pause
    {

    },
    onStop: function(context, frame, type, rv)
    {
    },

    onResume: function(context)
    {
    },

    onThrow: function(context, frame, rv)
    {
        return false; /* continue throw */
    },

    onError: function(context, frame, error)
    {
    },

    onEventScriptCreated: function(context, frame, url)
    {
    },

    onTopLevelScriptCreated: function(context, frame, url)
    {
    },

    onEvalScriptCreated: function(context, frame, url)
    {
    },

    onFunctionConstructor: function(context, frame, ctor_script, url)
    {
    },
};

// ************************************************************************************************

function CallstackPanel() { }

CallstackPanel.prototype = extend(Firebug.Panel,
{
    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * *
    // extends Panel

    name: "callstack",
    parentPanel: "script",
    order: 1,

    initialize: function(context, doc)
    {
        if (FBTrace.DBG_STACK) {                                                                                       /*@explore*/
            this.uid = FBL.getUniqueId();                                                                              /*@explore*/
            FBTrace.sysout("CallstackPanel.initialize:"+this.uid+"\n");                                                /*@explore*/
        }
        Firebug.Panel.initialize.apply(this, arguments);
    },

    destroy: function(state)
    {
        Firebug.Panel.destroy.apply(this, arguments);
    },

    show: function(state)
    {
          this.refresh();
    },

    supportsObject: function(object)
    {
        return object instanceof jsdIStackFrame;
    },

    updateSelection: function(object)
    {
        if (object instanceof jsdIStackFrame)
            this.highlightFrame(object);
    },

    refresh: function()
    {
        if (FBTrace.DBG_STACK)
            FBTrace.sysout("debugger.callstackPanel.refresh uid="+this.uid+"\n");                   /*@explore*/
        var mainPanel = this.context.getPanel("script", true);
        if (mainPanel.selection instanceof jsdIStackFrame)
            this.showStackFrame(mainPanel.selection);
    },

    showStackFrame: function(frame)
    {
        clearNode(this.panelNode);
        var mainPanel = this.context.getPanel("script", true);

        if (mainPanel && frame)
        {
            FBL.setClass(this.panelNode, "objectBox-stackTrace");
            // The panelStatus has the stack, lets reuse it to give the same UX as that control.
            var labels = panelStatus.getElementsByTagName("label");
            var doc = this.panelNode.ownerDocument;
            for (var i = 0; i < labels.length; i++)
            {
                if (FBL.hasClass(labels[i], "panelStatusLabel"))
                {
                    var div = doc.createElement("div");
                    var label = labels[i];
                    div.innerHTML = label.getAttribute('value');
                    if (label.repObject instanceof jsdIStackFrame)  // causes a downcast
                        div.frame = label.repObject;
                    div.label = label;
                    FBL.setClass(div, "objectLink");
                    FBL.setClass(div, "objectLink-stackFrame");

                    div.addEventListener("click", function(event)
                    {
                        var revent = document.createEvent("MouseEvents");
                        revent.initMouseEvent("mousedown", true, true, window,
                                0, 0, 0, 0, 0, false, false, false, false, 0, null);
                        event.target.label.dispatchEvent(revent);
                        if (FBTrace.DBG_STACK && event.target.label.repObject instanceof jsdIStackFrame)
                            FBTrace.sysout("debugger.showStackFrame click on "+event.target.label.repObject);
                    }, false);
                    this.panelNode.appendChild(div);
                }
            }
        }
    },

    highlightFrame: function(frame)
    {
        if (FBTrace.DBG_STACK)
            FBTrace.dumpProperties("debugger.callstackPanel.highlightFrame", frame);

        var frameViews = this.panelNode.childNodes
        for (var child = this.panelNode.firstChild; child; child = child.nextSibling)
        {
            if (child.label && child.label.repObject && child.label.repObject == frame)
            {
                this.selectItem(child);
                return true;
            }
        }
        return false;
    },

    selectItem: function(item)
    {
        if (this.selectedItem)
            this.selectedItem.removeAttribute("selected");

        this.selectedItem = item;

        if (item)
            item.setAttribute("selected", "true");
    },

    getOptionsMenuItems: function()
    {
        var items = [
            optionMenu("OmitObjectPathStack", "omitObjectPathStack"),
            ];
        return items;
    }
});

// ************************************************************************************************
// Local Helpers

function ConditionEditor(doc)
{
    this.box = this.tag.replace({}, doc, this);
    this.input = this.box.childNodes[1].firstChild.firstChild.lastChild;
    this.initialize();
}

ConditionEditor.prototype = domplate(Firebug.InlineEditor.prototype,
{
    tag:
        DIV({class: "conditionEditor"},
            DIV({class: "conditionEditorTop1"},
                DIV({class: "conditionEditorTop2"})
            ),
            DIV({class: "conditionEditorInner1"},
                DIV({class: "conditionEditorInner2"},
                    DIV({class: "conditionEditorInner"},
                        DIV({class: "conditionCaption"}, $STR("ConditionInput")),
                        INPUT({class: "conditionInput", type: "text"})
                    )
                )
            ),
            DIV({class: "conditionEditorBottom1"},
                DIV({class: "conditionEditorBottom2"})
            )
        ),

    show: function(sourceLine, panel, value)
    {
        this.target = sourceLine;
        this.panel = panel;

        this.getAutoCompleter().reset();

        hide(this.box, true);
        panel.selectedSourceBox.appendChild(this.box);

        this.input.value = value;

        setTimeout(bindFixed(function()
        {
            var offset = getClientOffset(sourceLine);

            var bottom = offset.y+sourceLine.offsetHeight;
            var y = bottom - this.box.offsetHeight;
            if (y < panel.selectedSourceBox.scrollTop)
            {
                y = offset.y;
                setClass(this.box, "upsideDown");
            }
            else
                removeClass(this.box, "upsideDown");

            this.box.style.top = y + "px";
            hide(this.box, false);

            this.input.focus();
            this.input.select();
        }, this));
    },

    hide: function()
    {
        this.box.parentNode.removeChild(this.box);

        delete this.target;
        delete this.panel;
    },

    layout: function()
    {
    },

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * *

    endEditing: function(target, value, cancel)
    {
        if (!cancel)
        {
            var sourceFile = this.panel.location;
            var lineNo = parseInt(this.target.textContent);

            if (value)
                fbs.setBreakpointCondition(sourceFile, lineNo, value, Firebug.Debugger);
            else
                fbs.clearBreakpoint(sourceFile.href, lineNo);
        }
    }
});

// * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * *

function setLineBreakpoints(sourceFile, sourceBox)
{
    fbs.enumerateBreakpoints(sourceFile.href, {call: function(url, line, script, props)
    {
        var scriptRow = sourceBox.childNodes[line-1];
        scriptRow.setAttribute("breakpoint", "true");
        if (props.disabled)
            scriptRow.setAttribute("disabledBreakpoint", "true");
        if (props.condition)
            scriptRow.setAttribute("condition", "true");
    }});

    if (FBTrace.DBG_LINETABLE)
        FBTrace.sysout("debugger.setLineBreakpoints for sourceFile.href:"+sourceFile.href+"\n");
}

function getCallingFrame(frame)
{
    try
    {
        do
        {
            frame = frame.callingFrame;
            if (!(Firebug.filterSystemURLs && isSystemURL(normalizeURL(frame.script.fileName))))
                return frame;
        }
        while (frame);
    }
    catch (exc)
    {
    }
    return null;
}

function getFrameWindow(frame)
{
    var result = {};
    if (frame.eval("window", "", 1, result))
    {
        var win = result.value.getWrappedValue();
        return getRootWindow(win);
    }
}

function getFrameContext(frame)
{
    var win = getFrameWindow(frame);
    return win ? TabWatcher.getContextByWindow(win) : null;
}

function cacheAllScripts(context)
{
    return;
    // TODO the scripts should all be ready
    for (var url in context.sourceFileMap)
        context.sourceFileMap[url].cache(context);
}

function countBreakpoints(context)
{
    var count = 0;
    for (var url in context.sourceFileMap)
    {
        fbs.enumerateBreakpoints(url, {call: function(url, lineNo)
        {
            ++count;
        }});
    }
    return count;
}
                                                                                                                       /*@explore*/
                                                                                                                     /*@explore*/

// ************************************************************************************************

Firebug.registerActivableModule(Firebug.Debugger);
Firebug.registerPanel(BreakpointsPanel);
Firebug.registerPanel(CallstackPanel);
Firebug.registerPanel(ScriptPanel);

// ************************************************************************************************

}});
