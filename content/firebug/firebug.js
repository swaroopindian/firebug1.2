/* See license.txt for terms of usage */

FBL.ns(function() { with (FBL) {

// ************************************************************************************************
// Constants

const Cc = Components.classes;
const Ci = Components.interfaces;

const nsIPrefBranch = Ci.nsIPrefBranch;
const nsIPrefBranch2 = Ci.nsIPrefBranch2;
const nsIFireBugClient = Ci.nsIFireBugClient;
const nsISupports = Ci.nsISupports;
const nsIFile = Ci.nsIFile;
const nsILocalFile = Ci.nsILocalFile;
const nsISafeOutputStream = Ci.nsISafeOutputStream;
const nsIURI = Ci.nsIURI;

const PrefService = Cc["@mozilla.org/preferences-service;1"];
const PermManager = Cc["@mozilla.org/permissionmanager;1"];
const DirService =  CCSV("@mozilla.org/file/directory_service;1", "nsIDirectoryServiceProvider");
const ioService = CCSV("@mozilla.org/network/io-service;1", "nsIIOService");

const nsIPrefService = Ci.nsIPrefService;
const prefService = PrefService.getService(nsIPrefService);

const nsIPermissionManager = Ci.nsIPermissionManager;
const permissionManager = CCSV("@mozilla.org/permissionmanager;1", "nsIPermissionManager");
const observerService = CCSV("@mozilla.org/observer-service;1", "nsIObserverService");

// * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * *

const contentBox = $("fbContentBox");
const contentSplitter = $("fbContentSplitter");
const toggleCommand = $("cmd_toggleFirebug");
const detachCommand = $("cmd_toggleDetachFirebug");
const tabBrowser = $("content");

// * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * *

const prefs = PrefService.getService(nsIPrefBranch2);
const pm = PermManager.getService(nsIPermissionManager);

const DENY_ACTION = nsIPermissionManager.DENY_ACTION;
const ALLOW_ACTION = nsIPermissionManager.ALLOW_ACTION;
const NS_OS_TEMP_DIR = "TmpD"

// * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * *

const firebugURLs =
{
    main: "http://www.getfirebug.com",
    docs: "http://www.getfirebug.com/docs.html",
    keyboard: "http://www.getfirebug.com/keyboard.html",
    discuss: "http://groups.google.com/group/firebug",
    issues: "http://code.google.com/p/fbug/issues/list",
    donate: "http://www.getfirebug.com/contribute.html?product"
};

const prefNames =
[
    "disabledAlways", "disabledFile", "allowSystemPages",
    "defaultPanelName", "throttleMessages", "textSize", "showInfoTips",
    "largeCommandLine", "textWrapWidth", "openInWindow", "showErrorCount",

    // Console
    "showJSErrors", "showJSWarnings", "showCSSErrors", "showXMLErrors",
    "showChromeErrors", "showChromeMessages", "showExternalErrors",
    "showXMLHttpRequests",

    // HTML
    "showFullTextNodes", "showCommentNodes", "showWhitespaceNodes",
    "highlightMutations", "expandMutations", "scrollToMutations", "shadeBoxModel",

    // CSS
    "showComputedStyle",

    // Script

    "breakOnTopLevel",
    "showAllSourceFiles",

    // DOM
    "showUserProps", "showUserFuncs", "showDOMProps", "showDOMFuncs", "showDOMConstants",

    // Layout
    "showRulers",

    // Net
    "netFilterCategory", "collectHttpHeaders",

    // Stack
    "omitObjectPathStack",
];

const servicePrefNames = [
    "showStackTrace", // Console
    "filterSystemURLs", // Stack
    "breakOnErrors",  "showEvalSources", "trackThrowCatch" // Script
];

const scriptBlockSize = 20;

// ************************************************************************************************
// Globals

var modules = [];
var activableModules = [];
var extensions = [];
var uiListeners = [];
var panelTypes = [];
var reps = [];
var defaultRep = null;
var editors = [];
var externalEditors = [];

var panelTypeMap = {};
var optionUpdateMap = {};

var deadWindows = [];
var deadWindowTimeout = 0;
var clearContextTimeout = 0;
var temporaryFiles = [];
var temporaryDirectory = null;

// ************************************************************************************************

top.Firebug =
{
    version: "1.2",

    module: modules,
    panelTypes: panelTypes,
    reps: reps,
    prefDomain: "extensions.firebug",

    stringCropLength: 80,

    tabBrowser: tabBrowser,

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * *
    // Initialization

    initialize: function()
    {
        var version = this.getVersion();
        if (version)
        {
            this.version = version;
            $('fbStatusIcon').setAttribute("tooltiptext", "Firebug "+version);
            $('fbStatusIcon').setAttribute("jsd", "off");
            var about = $('Firebug_About');
            if (about)
            {
                var aboutLabel = about.getAttribute("label");
                $('Firebug_About').setAttribute("label",  aboutLabel + " " + version);
            }
        }

        for (var i = 0; i < prefNames.length; ++i)
            this[prefNames[i]] = this.getPref(this.prefDomain, prefNames[i]);
        for (var i = 0; i < servicePrefNames.length; ++i)
            this[servicePrefNames[i]] = this.getPref("extensions.firebug-service", servicePrefNames[i]);

        this.loadExternalEditors();
        prefs.addObserver(this.prefDomain, this, false);
        prefs.addObserver("extensions.firebug-service", this, false);

        var basePrefNames = prefNames.length;
        dispatch(modules, "initialize", [this.prefDomain, prefNames]);

        for (var i = basePrefNames; i < prefNames.length; ++i)
            this[prefNames[i]] = this.getPref(this.prefDomain, prefNames[i]);

        if (FBTrace.DBG_OPTIONS)                                                                                       /*@explore*/
        {                                                                                                              /*@explore*/
             for (var i = 0; i < prefNames.length; ++i)                                                                /*@explore*/
                FBTrace.sysout("firebug.initialize option "+this.prefDomain+"."+prefNames[i]+"="+this[prefNames[i]]+"\n");                 /*@explore*/
        }                                                                                                              /*@explore*/
    },

    getVersion: function()
    {
        var versionURL = "chrome://firebug/content/branch.properties";
        var content = getResource(versionURL);
        var m = /RELEASE=(.*)/.exec(content);
        if (m)
        {
            var release = m[1];
        }
        m = /VERSION=(.*)/.exec(content);
        if (m)
        {
            var version = m[1];
        }
        if (release && version)
            return version+""+release;
        else
        {
            FBTrace.sysout("firebug.getVersion fails with release="+release+" branch="+branch+" from content="+content+"\n");
        }
    },

    /**
     * Called when the UI is ready to be initialized, once the panel browsers are loaded,
     * but before any contexts are created.
     */
    initializeUI: function(detachArgs)
    {
        if (FBTrace.DBG_INITIALIZE)                                                                                    /*@explore*/
            FBTrace.dumpProperties("firebug.initializeUI this.disabledAlways="+this.disabledAlways+					   /*@explore*/
                    " detachArgs:", detachArgs);                      												   /*@explore*/
                                                                                                                       /*@explore*/
        TabWatcher.initialize(this);

        // If another window is opened, then the creation of our first context won't
        // result in calling of enable, so we have to enable our modules ourself
        //if (fbs.enabled)
        dispatch(modules, "enable");  // allows errors to flow thru fbs and callbacks to supportWindow to begin

        dispatch(modules, "initializeUI", [detachArgs]);
    },

    shutdown: function()
    {
        TabWatcher.destroy();

        dispatch(modules, "disable");

        prefService.savePrefFile(null);
        prefs.removeObserver(this.prefDomain, this, false);
        prefs.removeObserver("extensions.firebug-service", this, false);

        dispatch(modules, "shutdown");

        this.closeDeadWindows();
        this.deleteTemporaryFiles();
                                                                                                                       /*@explore*/
        if (FBTrace.DBG_INITIALIZE) FBTrace.sysout("firebug.shutdown exited\n");                                       /*@explore*/
    },

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * *
    // Dead Windows

    killWindow: function(browser, chrome)
    {
        deadWindows.push({browser: browser, chrome: chrome});
        deadWindowTimeout = setTimeout(function() { Firebug.closeDeadWindows(); }, 3000);
    },

    rescueWindow: function(browser)
    {
        for (var i = 0; i < deadWindows.length; ++i)
        {
            if (deadWindows[i].browser == browser)
            {
                deadWindows.splice(i, 1);
                break;
            }
        }
    },

    closeDeadWindows: function()
    {
        for (var i = 0; i < deadWindows.length; ++i)
            deadWindows[i].chrome.close();

        deadWindows = [];
        deadWindowTimeout = 0;
    },

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * *
    // Registration

    registerModule: function()
    {
        modules.push.apply(modules, arguments);

        for (var i = 0; i < arguments.length; ++i)
            TabWatcher.addListener(arguments[i]);
                                                                                                                       /*@explore*/
        if (FBTrace.DBG_INITIALIZE) FBTrace.dumpProperties("registerModule", arguments);                                               /*@explore*/
    },

    registerActivableModule: function()
    {
        activableModules.push.apply(activableModules, arguments);
        this.registerModule.apply(this, arguments);
    },

    registerExtension: function()
    {
        extensions.push.apply(extensions, arguments);

        for (var i = 0; i < arguments.length; ++i)
            TabWatcher.addListener(arguments[i]);

        for (var j = 0; j < arguments.length; j++)
            uiListeners.push(arguments[j]);
    },

    registerPanel: function()
    {
        panelTypes.push.apply(panelTypes, arguments);

        for (var i = 0; i < arguments.length; ++i)
            panelTypeMap[arguments[i].prototype.name] = arguments[i];
                                                                                                                       /*@explore*/
        if (FBTrace.DBG_INITIALIZE)                                                                                    /*@explore*/
            for (var i = 0; i < arguments.length; ++i)                                                                 /*@explore*/
                FBTrace.sysout("registerPanel "+arguments[i].prototype.name+"\n");                                     /*@explore*/
    },

    registerRep: function()
    {
        reps.push.apply(reps, arguments);
    },

    setDefaultRep: function(rep)
    {
        defaultRep = rep;
    },

    registerEditor: function()
    {
        editors.push.apply(editors, arguments);
    },

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * *
    // Disabling

    enableAlways: function()
    {
        TabWatcher.activate();
    },

    disableAlways: function()
    {
        var currentSelected = TabWatcher.deactivate();
        if (currentSelected)
        {
            for (var i = 0; i < tabBrowser.browsers.length; ++i)
            {
                var browser = tabBrowser.browsers[i];
                TabWatcher.watchContext(browser.contentWindow, null);
            }
        }
    },

    disableSystemPages: function(disable)
    {
        this.setPref(Firebug.prefDomain, "allowSystemPages", !disable);
        this.disableCurrent(disable);
    },

    disableSite: function(disable)
    {
        var host;
        try
        {
            host = tabBrowser.currentURI.host;
        }
        catch (exc)
        {
            // XXXjjb eg about:neterror and friends.
        }
        if (isSystemURL(tabBrowser.currentURI.spec))
            this.setPref(this.prefDomain, "allowSystemPages", !disable);
        else if (!host)
            this.setPref(this.prefDomain, "disabledFile", disable);
        else
        {
            var uri = ioService.newURI("http://" + host, null, null);
            if (disable)
                pm.add(uri, "firebug", DENY_ACTION);
            else
            {
                if (this.isURIDenied(uri))
                    pm.remove(host, "firebug");
                else
                    pm.add(uri, "firebug", ALLOW_ACTION);
            }
        }
        this.disableCurrent(disable);
    },

    disableCurrent: function(disable)
    {
        if (!tabBrowser)
            return; // externalBrowser

        if (disable)
        {
            TabWatcher.unwatchBrowser(tabBrowser.selectedBrowser);
            for (var i = 0; i < tabBrowser.browsers.length; ++i)
            {
                var browser = tabBrowser.browsers[i];
                TabWatcher.watchContext(browser.contentWindow, null);
            }
        }
        else
        {
            TabWatcher.activate();  // These statement are redundant
            TabWatcher.watchBrowser(tabBrowser.selectedBrowser);
        }

    },

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * *
    // Options

    togglePref: function(name)
    {
        this.setPref(Firebug.prefDomain, name, !this[name]);
    },

    getPref: function(prefDomain, name)
    {
        var prefName = prefDomain + "." + name;

        var type = prefs.getPrefType(prefName);
        if (type == nsIPrefBranch.PREF_STRING)
            return prefs.getCharPref(prefName);
        else if (type == nsIPrefBranch.PREF_INT)
            return prefs.getIntPref(prefName);
        else if (type == nsIPrefBranch.PREF_BOOL)
            return prefs.getBoolPref(prefName);
    },

    setPref: function(prefDomain, name, value)
    {
        var prefName = prefDomain + "." + name;

        var type = prefs.getPrefType(prefName);
        if (type == nsIPrefBranch.PREF_STRING)
            prefs.setCharPref(prefName, value);
        else if (type == nsIPrefBranch.PREF_INT)
            prefs.setIntPref(prefName, value);
        else if (type == nsIPrefBranch.PREF_BOOL)
            prefs.setBoolPref(prefName, value);
        else if (type == nsIPrefBranch.PREF_INVALID)
            throw "Invalid preference "+prefName+" check that it is listed in defaults/prefs.js";

        if (FBTrace.DBG_OPTIONS)                                                                                       /*@explore*/
            FBTrace.sysout("firebug.setPref type="+type+" name="+prefName+" value="+value+"\n");                       /*@explore*/
    },

    increaseTextSize: function(amt)
    {
        this.setTextSize(this.textSize+amt);
    },

    setTextSize: function(value)
    {
        this.setPref(Firebug.prefDomain, "textSize", value);
    },

    updatePref: function(name, value)
    {
        // Prevent infinite recursion due to pref observer
        if ( optionUpdateMap.hasOwnProperty(name) )
            return;

        optionUpdateMap[name] = 1;
        this[name] = value;

        dispatch(modules, "updateOption", [name, value]);

        FirebugChrome.updateOption(name, value);

        if (TabWatcher.contexts)
        {
            for (var i = 0; i < TabWatcher.contexts.length; ++i)
            {
                var context = TabWatcher.contexts[i];
                if (context.externalChrome)
                    context.chrome.updateOption(name, value);
            }
        }

        if (name == "disabledAlways")
        {
            if (value)
                this.disableAlways();
            else
                this.enableAlways();
        }
        if (name.substr(0, 15) == "externalEditors")
        {
            this.loadExternalEditors();
        }

        delete optionUpdateMap[name];
                                                                                                                       /*@explore*/
        if (FBTrace.DBG_OPTIONS)  /*@explore*/
            FBTrace.sysout("firebug.updatePref EXIT: "+name+"="+value+"\n");                      /*@explore*/
    },

    loadExternalEditors: function()
    {
        const prefName = "externalEditors";
        const editorPrefNames = ["label", "executable", "cmdline", "image"];

        externalEditors = [];
        var list = this.getPref(this.prefDomain, prefName).split(",");
        for (var i = 0; i < list.length; ++i)
        {
            var editorId = list[i];
            if ( !editorId || editorId == "")
                continue;
            var item = { id: editorId };
            for( var j = 0; j < editorPrefNames.length; ++j )
            {
                try {
                    item[editorPrefNames[j]] = this.getPref(this.prefDomain, prefName+"."+editorId+"."+editorPrefNames[j]);
                }
                catch(exc)
                {
                }
            }
            if ( item.label && item.executable )
            {
                if (!item.image)
                    item.image = getIconURLForFile(item.executable);
                externalEditors.push(item);
            }
        }
    },

    get registeredEditors()
    {
        var newArray = [];
        if ( editors.length > 0 )
        {
            newArray.push.apply(newArray, editors);
            if ( externalEditors.length > 0 )
                newArray.push("-");
        }
        if ( externalEditors.length > 0 )
            newArray.push.apply(newArray, externalEditors);

        return newArray;
    },

    openPermissions: function()
    {
        var params = {
            permissionType: "firebug",
            windowTitle: $STR("FirebugPermissions"),
            introText: $STR("FirebugPermissionsIntro"),
            blockVisible: true, sessionVisible: false, allowVisible: true, prefilledHost: ""
        };

        openWindow("Browser:Permissions", "chrome://browser/content/preferences/permissions.xul",
            "", params);
    },

    openEditors: function()
    {
        var args = {
            FBL: FBL,
            prefName: this.prefDomain + ".externalEditors"
        };
        openWindow("Firebug:ExternalEditors", "chrome://firebug/content/editors.xul", "", args);
    },

    openInEditor: function(context, editorId)
    {
        try {
        if (!editorId)
            return;

        var location;
        if (context)
        {
            var panel = context.chrome.getSelectedPanel();
            if (panel)
            {
                location = panel.location;
                if (!location && panel.name == "html")
                    location = context.window.document.location;
                if ( location instanceof SourceFile || location instanceof CSSStyleSheet )
                    location = location.href;
            }
        }
        if (!location)
        {
            if (tabBrowser.currentURI)
                location = tabBrowser.currentURI.asciiSpec;
        }
        if (!location)
            return;
        location = location.toString();
        if (isSystemURL(location))
            return;

        var list = extendArray(editors, externalEditors);
        var editor = null;
        for( var i = 0; i < list.length; ++i )
        {
            if (editorId == list[i].id)
            {
                editor = list[i];
                break;
            }
        }
        if (editor)
        {
            if (editor.handler)
            {
                editor.handler(location);
                return;
            }
            var args = [];
            var localFile = null;
            var targetAdded = false;
            if (editor.cmdline)
            {
                args = editor.cmdline.split(" ");
                for( var i = 0; i < args.length; ++i )
                {
                    if ( args[i] == "%url" )
                    {
                        args[i] = location;
                        targetAdded = true;
                    }
                    else if ( args[i] == "%file" )
                    {
                        if (!localFile)
                            localFile = this.getLocalSourceFile(context, location);
                        args[i] = localFile;
                        targetAdded = true;
                    }
                }
            }
            if (!targetAdded)
            {
                localFile = this.getLocalSourceFile(context, location);
                if (!localFile)
                    return;
                args.push(localFile);
            }
            FBL.launchProgram(editor.executable, args);
        }
        }catch(exc) { ERROR(exc); }
    },

    getLocalSourceFile: function(context, href)
    {
        if ( isLocalURL(href) )
            return getLocalPath(href);
        var data;
        if (context)
        {
            data = context.sourceCache.loadText(href);
        } else
        {
            var ctx = { browser: tabBrowser.selectedBrowser, window: tabBrowser.selectedBrowser.contentWindow };
            data = new SourceCache(ctx).loadText(href);
        }
        if (!data)
            return;
        if (!temporaryDirectory)
        {
            var tmpDir = DirService.getFile(NS_OS_TEMP_DIR, {});
            tmpDir.append("fbtmp");
            tmpDir.createUnique(nsIFile.DIRECTORY_TYPE, 0775);
            temporaryDirectory = tmpDir;
        }

        var lpath = href.replace(/^[^:]+:\/*/g, "").replace(/\?.*$/g, "").replace(/[^0-9a-zA-Z\/.]/g, "_");
        if ( !/\.[\w]{1,5}$/.test(lpath) )
        {
            if ( lpath.charAt(lpath.length-1) == '/' )
                lpath += "index";
            lpath += ".html";
        }
        if ( getPlatformName() == "WINNT" )
            lpath = lpath.replace(/\//g, "\\");
        var file = QI(temporaryDirectory.clone(), nsILocalFile);
        file.appendRelativePath(lpath);
        if (!file.exists())
            file.create(nsIFile.NORMAL_FILE_TYPE, 664);
        temporaryFiles.push(file.path);

        var stream = CCIN("@mozilla.org/network/safe-file-output-stream;1", "nsIFileOutputStream");
        stream.init(file, 0x04 | 0x08 | 0x20, 664, 0); // write, create, truncate
        stream.write(data, data.length);
        if (stream instanceof nsISafeOutputStream)
            stream.finish();
        else
            stream.close();

        return file.path;
    },

    deleteTemporaryFiles: function()
    {
        try {
            var file = CCIN("@mozilla.org/file/local;1", "nsILocalFile");
            for( var i = 0; i < temporaryFiles.length; ++i)
            {
                file.initWithPath(temporaryFiles[i]);
                if (file.exists())
                    file.remove(false);
            }
        }
        catch(exc)
        {
        }
        try {
            if (temporaryDirectory && temporaryDirectory.exists())
                temporaryDirectory.remove(true);
        } catch(exc)
        {
        }
    },

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * *
    // Browser Bottom Bar

    showBar: function(show)
    {
        var browser = FirebugChrome.getCurrentBrowser();
        browser.showFirebug = show;

        var shouldShow = show && !browser.detached;
        contentBox.setAttribute("collapsed", !shouldShow);
        contentSplitter.setAttribute("collapsed", !shouldShow);
        toggleCommand.setAttribute("checked", !!shouldShow);
        detachCommand.setAttribute("checked", !!browser.detached);
        this.showKeys(shouldShow);

        dispatch(modules, show ? "showUI" : "hideUI", [browser, FirebugContext]);
    },

    showKeys: function(shouldShow)
    {
        var keyset = document.getElementById("mainKeyset");
        var keys = FBL.getElementByClass(keyset, "fbOnlyKey");
        for (var i = 0; i < keys.length; i++)
        {
            keys[i].setAttribute("disabled", !!shouldShow);
        }
    },

    toggleBar: function(forceOpen, panelName)
    {
        if (Firebug.openInWindow)
            return this.toggleDetachBar(true);

        var browser = FirebugChrome.getCurrentBrowser();
        if (!browser.chrome)
            return;

        var toggleOff = forceOpen == undefined ? !contentBox.collapsed : !forceOpen;
        if (toggleOff == contentBox.collapsed)
            return;

        if (panelName)
            browser.chrome.selectPanel(panelName);

        if (browser.detached)
            browser.chrome.focus();
        else
        {
            if (toggleOff)
                browser.chrome.hidePanel();
            else
                browser.chrome.syncPanel();

            this.showBar(!toggleOff);
        }
    },

    toggleDetachBar: function(forceOpen)
    {
        var browser = FirebugChrome.getCurrentBrowser(); // XXXjjb Joe check tabBrowser.selectedBrowser;
        if (!forceOpen && browser.detached)
        {
            browser.chrome.close();
            detachCommand.setAttribute("checked", false);
        }
        else
            this.detachBar();
    },

    detachBar: function()
    {
        var browser = FirebugChrome.getCurrentBrowser(); // XXXjjb Joe check tabBrowser.selectedBrowser;
        if (!browser.chrome)
            return;

        if (browser.detached)
            browser.chrome.focus();
        else
        {
            if (FirebugContext)
                FirebugContext.detached = true;

            browser.detached = true;

            var args = {
                    FBL: FBL,
                    Firebug: this,
                    browser: browser,
                    context: FirebugContext
            };
            openWindow("Firebug", "chrome://firebug/content/firebug.xul", "", args);
            detachCommand.setAttribute("checked", true);

            FirebugChrome.clearPanels();
            this.syncBar();
        }
    },

    syncBar: function()
    {
        var browser = FirebugChrome.getCurrentBrowser();
        this.showBar(browser && browser.showFirebug);
    },

    onClickStatusIcon: function(context, event)
    {
        if (event.button != 0)
            return;
        else if (isControl(event))
            this.toggleDetachBar(true);
        else if (context && context.errorCount)
            Firebug.toggleBar(undefined, 'console');
        else
            this.toggleBar();
    },

    onClickStatusText: function(context, event)
    {
        if (event.button != 0)
            return;

        if (!context || !context.errorCount)
            return;

        var browser = FirebugChrome.getCurrentBrowser();
        if (!browser.chrome)
            return;

        var panel = browser.chrome.getSelectedPanel();
        if (panel && panel.name != "console")
        {
            browser.chrome.selectPanel("console");
            cancelEvent(event);
        }
    },

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * *
    // Panels

    getPanelType: function(panelName)
    {
        return panelTypeMap[panelName];
    },

    getMainPanelTypes: function(context)
    {
        var resultTypes = [];

        for (var i = 0; i < panelTypes.length; ++i)
        {
            var panelType = panelTypes[i];
            if (!panelType.prototype.parentPanel)
                resultTypes.push(panelType);
        }

        if (context.panelTypes)
        {
            for (var i = 0; i < context.panelTypes.length; ++i)
            {
                var panelType = context.panelTypes[i];
                if (!panelType.prototype.parentPanel)
                    resultTypes.push(panelType);
            }
        }

        return resultTypes;
    },

    getSidePanelTypes: function(context, mainPanel)
    {
        if (!mainPanel)
            return [];

        var resultTypes = [];

        for (var i = 0; i < panelTypes.length; ++i)
        {
            var panelType = panelTypes[i];
            if (panelType.prototype.parentPanel == mainPanel.name)
                resultTypes.push(panelType);
        }

        if (context.panelTypes)
        {
            for (var i = 0; i < context.panelTypes.length; ++i)
            {
                var panelType = context.panelTypes[i];
                if (panelType.prototype.parentPanel == mainPanel.name)
                    resultTypes.push(panelType);
            }
        }

        resultTypes.sort(function(a, b)
        {
            return a.prototype.order < b.prototype.order ? -1 : 1;
        });

        return resultTypes;
    },

    /**
     * Gets an object containing the state of the panel from the last time
     * it was displayed before one or more page reloads.
     */
    getPanelState: function(panel)
    {
        var persistedState = panel.context.persistedState;
        return persistedState ? persistedState.panelState[panel.name] : null;
    },

    showPanel: function(browser, panel)
    {
        dispatch(modules, "showPanel", [browser, panel]);
    },

    showSidePanel: function(browser, panel)
    {
        dispatch(modules, "showSidePanel", [browser, panel]);
    },

    reattachContext: function(browser, context)
    {
        dispatch(modules, "reattachContext", [browser, context]);
    },

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * *
    // URL mapping

    getObjectByURL: function(context, url)
    {
        for (var i = 0; i < modules.length; ++i)
        {
            var object = modules[i].getObjectByURL(context, url);
            if (object)
                return object;
        }
    },

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * *
    // Reps

    getRep: function(object)
    {
        var type = typeof(object);
        for (var i = 0; i < reps.length; ++i)
        {
            var rep = reps[i];
            try
            {
                if (rep.supportsObject(object, type))
                    return rep;
            }
            catch (exc)
            {
                if (FBTrace.dumpProperties)
                {
                    FBTrace.dumpProperties("firebug.getRep FAILS at i/reps.length: "+i+"/"+reps.length+" type:"+type+" exc:", exc);
                    FBTrace.dumpProperties("firebug.getRep reps[i]", reps[i]);
                    FBTrace.dumpProperties("firebug.getRep object:", object);
                }
            }
        }

        return defaultRep;
    },

    getRepObject: function(node)
    {
        var target = null;
        for (var child = node; child; child = child.parentNode)
        {
            if (hasClass(child, "repTarget"))
                target = child;

            if (child.repObject)
            {
                if (!target && hasClass(child, "repIgnore"))
                    break;
                else
                    return child.repObject;
            }
        }
    },

    getRepNode: function(node)
    {
        for (var child = node; child; child = child.parentNode)
        {
            if (child.repObject)
                return child;
        }
    },

    getElementByRepObject: function(element, object)
    {
        for (var child = element.firstChild; child; child = child.nextSibling)
        {
            if (child.repObject == object)
                return child;
        }
    },

    /**
     * Takes an element from a panel document and finds the owning panel.
     */
    getElementPanel: function(element)
    {
        for (; element; element = element.parentNode)
        {
            if (element.ownerPanel)
                return element.ownerPanel;
        }
    },

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * *

    visitWebsite: function(which)
    {
        openNewTab(firebugURLs[which]);
    },

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * *
    // nsISupports

    QueryInterface : function(iid)
    {
        if (iid.equals(nsIFireBugClient) || iid.equals(nsISupports))
        {
            return this;
        }

        throw Components.results.NS_NOINTERFACE;
    },

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * *
    // nsIPrefObserver
    rePrefs: /extensions\.([^\.]*)\.(.*)/,
    observe: function(subject, topic, data)
    {
        if (data.indexOf("extensions.") == -1)
            return;

        var m = top.Firebug.rePrefs.exec(data);
        if (m)
        {
            if (m[1] == "firebug")
                var domain = "extensions.firebug";
            if (m[1] == "firebug-service")
                var domain = "extensions.firebug-service";
        }
        if (domain)
        {
            var name = data.substr(domain.length+1);
            var value = this.getPref(domain, name);
            if (FBTrace.DBG_OPTIONS) FBTrace.sysout("firebug.observe name = value: "+name+"= "+value+"\n");                /*@explore*/
            this.updatePref(name, value);
        }
    },

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * *
    // nsIFireBugClient

    enable: function()  // Called by firebug-service when the first context is created.
    {
        dispatch(modules, "enable");
    },

    disable: function()
    {
        dispatch(modules, "disable");
    },

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * *
    // TabWatcher Owner

    isURIAllowed: function(uri)
    {
        return true;

        // xxxHonza
        /*
        if (!uri)  // null or undefined is denied
            return false;
        var url  = (uri instanceof nsIURI) ? uri.spec : uri.toString();
        if (FBL.isLocalURL(url) && !this.disabledFile)
            return true;
        if (isSystemURL(url) && Firebug.allowSystemPages)
            return true;
        if (uri instanceof nsIURI)
        {
               if (pm.testPermission(uri, "firebug") == ALLOW_ACTION)
                return true;
        }
        return false;
        */
    },

    isURIDenied: function(uri)
    {
        return false;

        //xxxHonza
        /*
        if (!uri)  // null or undefined is denied
            return true;
        var url  = (uri instanceof nsIURI) ? uri.spec : uri.toString();
        if (isSystemURL(url) && !Firebug.allowSystemPages)
            return true;
        if (uri instanceof nsIURI)
        {
            if (pm.testPermission(uri, "firebug") == DENY_ACTION)
                return true;
        } // else we cannot test! TODO
        if (FBL.isLocalURL(url) && this.disabledFile)
            return true;
        return false;
        */
    },

    enableContext: function(win, uri)  // currently this can be called with nsIURI or a string URL.
    {
        if (FBTrace.DBG_WINDOWS)                       														/*@explore*/
            FBTrace.sysout("-> enableContext for: ", ((uri instanceof nsIURI)?uri.spec:uri)+"\n");                             				/*@explore*/

        if ( dispatch2(extensions, "acceptContext", [win, uri]) )
            return true;
        if ( dispatch2(extensions, "declineContext", [win, uri]) )
            return false;

        if (this.disabledAlways)
        {
            // Check if the whitelist makes an exception
            if (!this.isURIAllowed(uri))
                return false;
        }
        else
        {
            // Check if the blacklist says no
            if (this.isURIDenied(uri))
                return false;
        }
        return true;
    },

    createTabContext: function(win, browser, chrome, state)
    {
        return new Firebug.TabContext(win, browser, chrome, state);
    },

    destroyTabContext: function(browser, context)
    {
        if (context)
        {
            // Persist remnants of the context for restoration if the user reloads
            context.browser.panelName = context.panelName;
            context.browser.sidePanelNames = context.sidePanelNames;

            if (browser.detached || context == FirebugContext)
            {
                clearContextTimeout = setTimeout(function()
                {
                    if (context == FirebugContext)
                    {
                        browser.isSystemPage = true;
                        Firebug.showContext(browser, null);
                    }
                }, 100);

                browser.chrome.clearPanels();
            }

            if (context.externalChrome)
            {
                if (browser.firebugReload)
                    delete browser.firebugReload; // and don't kiiWindow
                else
                    this.killWindow(context.browser, context.externalChrome);
            }
        }
        else if (browser.detached)
            this.killWindow(browser, browser.chrome);
    },

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * *
    // TabWatcher Listener

    initContext: function(context)
    {
        context.panelName = context.browser.panelName;
        if (context.browser.sidePanelNames)
            context.sidePanelNames = context.browser.sidePanelNames;
    },

    showContext: function(browser, context)
    {
        if (clearContextTimeout)
        {
            clearTimeout(clearContextTimeout);
            clearContextTimeout = 0;
        }

        if (deadWindowTimeout)
            this.rescueWindow(browser);

        if (browser)
            browser.chrome.showContext(browser, context);

        FirebugContext = context;  // Maybe null

        if (FBTrace.DBG_DISPATCH || FBTrace.DBG_ERRORS)
            FBTrace.sysout("firebug.showContext context: "+(context?context.window.location:"null ")+"\n");

        this.syncBar();
    },

    watchWindow: function(context, win)
    {
        for (var panelName in context.panelMap)
        {
            var panel = context.panelMap[panelName];
            panel.watchWindow(win);
        }
    },

    unwatchWindow: function(context, win)
    {
        for (var panelName in context.panelMap)
        {
            var panel = context.panelMap[panelName];
            panel.unwatchWindow(win);
        }
    },

    loadedContext: function(context)
    {
        //context.browser.chrome.showLoadedContext(context);
    },
    //***********************************************************************

    getTabIdForWindow: function(aWindow)
    {
        aWindow = getRootWindow(aWindow);

        if (!aWindow || !this.tabBrowser.getBrowserIndexForDocument)
            return null;

        try {
            var targetDoc = aWindow.document;

            var tab = null;
            var targetBrowserIndex = this.tabBrowser.getBrowserIndexForDocument(targetDoc);

            if (targetBrowserIndex != -1)
            {
                tab = this.tabBrowser.tabContainer.childNodes[targetBrowserIndex];
                return tab.linkedPanel;
            }
        } catch (ex) {}

        return null;
    },

};

// ************************************************************************************************

Firebug.Module =
{
    /**
     * Called when the window is opened.
     */
    initialize: function()
    {
    },

    /**
     * Called when the UI is ready for context creation.
     * Used by chromebug; normally FrameProgressListener events trigger UI synchronization,
     * this event allows sync without progress events.
     */
    initializeUI: function(detachArgs)
    {
    },

    /**
     * Called when the window is closed.
     */
    shutdown: function()
    {

    },

    /**
     * Called when a new context is created but before the page is loaded.
     */
    initContext: function(context)
    {
    },

    /**
     * Called after a context is detached to a separate window;
     */
    reattachContext: function(browser, context)
    {
    },

    /**
     * Called when a context is destroyed.
     */
    destroyContext: function(context, persistedState)
    {
    },

    /**
     * Called when attaching to a window (top-level or frame).
     */
    watchWindow: function(context, win)
    {
    },

    /**
     * Called when unwatching a window (top-level or frame).
     */
    unwatchWindow: function(context, win)
    {
    },

    // Called when a FF tab is create or activated (user changes FF tab)
    // Called after context is created or with context == null (to abort?)
    showContext: function(browser, context)
    {
    },

    /**
     * Called after a context's page is loaded
     */
    loadedContext: function(context)
    {
    },

    showPanel: function(browser, panel)
    {
    },

    showSidePanel: function(browser, panel)
    {
    },

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * *

    updateOption: function(name, value)
    {
    },

    getObjectByURL: function(context, url)
    {
    }
};

// ************************************************************************************************

Firebug.Extension =
{
    acceptContext: function(win,uri)
    {
        return false;
    },

    declineContext: function(win,uri)
    {
        return false;
    }
};

// ************************************************************************************************

Firebug.Panel =
{
    searchable: false,
    editable: true,
    order: 2147483647,
    statusSeparator: "<",

    initialize: function(context, doc)
    {
        this.context = context;
        this.document = doc;

        this.panelNode = doc.createElement("div");
        this.panelNode.ownerPanel = this;

        setClass(this.panelNode, "panelNode panelNode-"+this.name+" contextUID="+context.uid);
        doc.body.appendChild(this.panelNode);

        if (FBTrace.DBG_INITIALIZE)
            FBTrace.sysout("firebug.initialize panelNode for "+this.name+"\n");

        this.initializeNode(this.panelNode);
    },

    destroy: function(state)
    {
        if (this.panelNode)
            delete this.panelNode.ownerPanel;

        this.destroyNode();
    },

    detach: function(oldChrome, newChrome)
    {
        this.lastScrollTop = this.panelNode.scrollTop;
    },

    reattach: function(doc)
    {
        this.document = doc;

        if (this.panelNode)
        {
            this.panelNode = doc.importNode(this.panelNode, true);
            this.panelNode.ownerPanel = this;
            doc.body.appendChild(this.panelNode);
            this.panelNode.scrollTop = this.lastScrollTop;
            delete this.lastScrollTop;
        }
    },

    // Called after module.initialize; addEventListener-s here
    initializeNode: function(myPanelNode)
    {
    },

    // removeEventListener-s here.
    destroyNode: function()
    {
    },

    show: function(state)
    {
    },

    hide: function()
    {
    },

    watchWindow: function(win)
    {
    },

    unwatchWindow: function(win)
    {
    },

    updateOption: function(name, value)
    {
    },

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * *

    /**
     * Toolbar helpers
     */
    showToolbarButtons: function(buttonsId, show)
    {
        var buttons = this.context.browser.chrome.$(buttonsId);
        if (buttons)
            collapse(buttons, show ? "false" : "true");
    },

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * *

    /**
     * Returns a number indicating the view's ability to inspect the object.
     *
     * Zero means not supported, and higher numbers indicate specificity.
     */
    supportsObject: function(object)
    {
        return 0;
    },

    navigate: function(object)
    {
        if (FBTrace.DBG_PANELS)
            FBTrace.sysout("navigate "+object+"\n");
        if (!object)
            object = this.getDefaultLocation();

        if (object != this.location)
        {
            this.location = object;
            this.updateLocation(object);

            // XXXjoe This is kind of cheating, but, feh.
            this.context.chrome.onPanelNavigate(object, this);
            if (uiListeners.length > 0) dispatch(uiListeners, "onPanelNavigate", [object, this]);  // TODO: make this.context.chrome a uiListener
        }
    },

    updateLocation: function(object)
    {
    },

    select: function(object, forceUpdate)
    {
        if(FBTrace.DBG_PANELS)    /*@explore*/
            FBTrace.sysout("firebug.select (object != this.selection)? "+(object != this.selection), " object: "+object);  /*@explore*/
        if (!object)
            object = this.getDefaultSelection();

        if (forceUpdate || object != this.selection)
        {
            this.previousSelection = this.selection;
            this.selection = object;
            this.updateSelection(object);

            // XXXjoe This is kind of cheating, but, feh.
            this.context.chrome.onPanelSelect(object, this);
            if (uiListeners.length > 0) dispatch(uiListeners, "onPanelSelect", [object, this]);  // TODO: make this.context.chrome a uiListener
        }
    },


    updateSelection: function(object)
    {
    },

    refresh: function()
    {

    },

    markChange: function(skipSelf)
    {
        if (this.dependents)
        {
            if (skipSelf)
            {
                for (var i = 0; i < this.dependents.length; ++i)
                {
                    var panelName = this.dependents[i];
                    if (panelName != this.name)
                        this.context.invalidatePanels(panelName);
                }
            }
            else
                this.context.invalidatePanels.apply(this.context, this.dependents);
        }
    },

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * *

    startInspecting: function()
    {
    },

    stopInspecting: function(object, cancelled)
    {
    },

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * *

    search: function(text)
    {
    },

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * *

    // An array of objects that answer to getObjectLocation.
    // Only shown if panel.location defined and supportsObject true
    getLocationList: function()
    {
        return null;
    },

    // Called when "Options" clicked. Return array of
    // {label: 'name', nol10n: true,  type: "checkbox", checked: <value>, command:function to set <value>}
    getOptionsMenuItems: function()
    {
        return null;
    },

    getContextMenuItems: function(object, target)
    {
        return [];
    },

    getEditor: function(target, value)
    {
    },

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * *

    getDefaultLocation: function(context)
    {
        return null;
    },

    getDefaultSelection: function(context)
    {
        return null;
    },

    browseObject: function(object)
    {
    },

    getPopupObject: function(target)
    {
        return Firebug.getRepObject(target);
    },

    getTooltipObject: function(target)
    {
        return Firebug.getRepObject(target);
    },

    showInfoTip: function(infoTip, x, y)
    {

    },

    getObjectPath: function(object)
    {
        return null;
    },

    getObjectLocation: function(object)
    {
        return "";
    },

    // return.path: group/category label, return.name: item label
    getObjectDescription: function(object)
    {
        var url = this.getObjectLocation(object);
        return FBL.splitURLBase(url);
    }

};

// ************************************************************************************************

Firebug.SourceBoxPanel = function() {} // XXjjb attach Firebug so this panel can be extended.

Firebug.SourceBoxPanel = extend(Firebug.Panel,
{
    // ******* override in extenders ********
    updateSourceBox: function(sourceBox)
    {
        // called just before box is shown
    },

    getSourceType: function()
    {
        // eg "js" or "css"
        throw "Need to override in extender";
    },
    // **************************************


    initializeSourceBoxes: function()
    {
        this.sourceBoxes = {};
        this.anonSourceBoxes = []; // XXXjjb I don't think these are used now, everything is in the sourceCache
    },

    showSourceBox: function(sourceBox)
    {
        if (this.selectedSourceBox)
            collapse(this.selectedSourceBox, true);

        this.selectedSourceBox = sourceBox;
        delete this.currentSearch;

        if (sourceBox)
        {
            this.updateSourceBox(sourceBox);
            collapse(sourceBox, false);
        }
    },

    createSourceBox: function(sourceFile, sourceBoxDecorator)  // decorator(sourceFile, sourceBox)
    {
        var lines = loadScriptLines(sourceFile, this.context);
        if (!lines)
            return null;

        var maxLineNoChars = (lines.length + "").length;

        var sourceBox = this.document.createElement("div");
        sourceBox.repObject = sourceFile;
        setClass(sourceBox, "sourceBox");
        collapse(sourceBox, true);
        //

        // For performance reason, append script lines in large chunks using the throttler,
        // otherwise displaying a large script will freeze up the UI
        var min = 0;
        if (sourceFile.lineNumberShift)
            min = min + sourceFile.lineNumberShift;

        var totalMax = lines.length;
        if (sourceFile.lineNumberShift)
            totalMax = totalMax + sourceFile.lineNumberShift; // eg -1

        do
        {
            var max = min + scriptBlockSize;
            if (max > totalMax)
                max = totalMax;

            var args = [lines, min+1, max, maxLineNoChars, sourceBox];
            this.context.throttle(appendScriptLines, top, args);

            min += scriptBlockSize;
        } while (max < totalMax);

        if (sourceBoxDecorator)
            this.context.throttle(sourceBoxDecorator, top, [sourceFile, sourceBox]);

        if (sourceFile.source)
            this.anonSourceBoxes.push(sourceBox);
        else
            this.sourceBoxes[sourceFile.href] = sourceBox;

        if (FBTrace.DBG_SOURCEFILES)                                                                                                /*@explore*/
            FBTrace.sysout("firebug.createSourceBox: ", sourceFile+(sourceFile.source?" anon ":" sourceBoxes")); /*@explore*/

        return sourceBox;
    },

    getSourceBoxBySourceFile: function(sourceFile)
    {
        if (!sourceFile.source)
            return this.getSourceBoxByURL(sourceFile.href);

        for (var i = 0; i < this.anonSourceBoxes.length; ++i)
        {
            var sourceBox = this.anonSourceBoxes[i];
            if (sourceBox.repObject == sourceFile)
                return sourceBox;
        }
    },

    getSourceBoxByURL: function(url)
    {
        // if this.sourceBoxes is undefined, you need to call initializeSourceBoxes in your panel.initialize()
        return url ? this.sourceBoxes[url] : null;
    },

    showSourceFile: function(sourceFile, sourceBoxDecorator)
    {
        var sourceBox = this.getSourceBoxBySourceFile(sourceFile);
        if (FBTrace.DBG_SOURCEFILES)                                                                                                /*@explore*/
            FBTrace.sysout("firebug.showSourceFile: ", sourceFile+(sourceBox?" has sourcebox ":" needs new sourcebox ")); /*@explore*/
        if (!sourceBox)
        {
            sourceBox = this.createSourceBox(sourceFile, sourceBoxDecorator);
            this.panelNode.appendChild(sourceBox);
        }

        this.showSourceBox(sourceBox);
    },

    getLineNode: function(lineNo)
    {
        return this.selectedSourceBox ? this.selectedSourceBox.childNodes[lineNo-1] : null;
    },

    getSourceLink: function(lineNo)
    {
        return new SourceLink(this.selectedSourceBox.repObject.href, lineNo, this.getSourceType());
    },

    scrollToLine: function(lineNo, highlight)
    {
        if (FBTrace.DBG_LINETABLE) FBTrace.sysout("SourceBoxPanel.scrollToLine: "+lineNo+"\n");

        if (this.context.scrollTimeout)
        {
            this.context.clearTimeout(this.contextscrollTimeout);
            delete this.context.scrollTimeout
        }

        this.context.scrollTimeout = this.context.setTimeout(bindFixed(function()
        {
            this.highlightLine(lineNo, highlight);
        }, this));
    },

    highlightLine: function(lineNo, highlight)
    {
        var lineNode = this.getLineNode(lineNo);
        if (lineNode)
        {
            var visibleRange = linesIntoCenterView(lineNode, this.selectedSourceBox);
            var min = lineNo - visibleRange.before;
            var max = lineNo + visibleRange.after;

            this.markVisible(min, max);

            if (highlight)
                setClassTimed(lineNode, "jumpHighlight", this.context);

            if (uiListeners.length > 0)
            {
                var link = new SourceLink(this.selectedSourceBox.repObject.href, lineNo, this.getSourceType());
                dispatch(uiListeners, "onLineSelect", [link]);
            }

            return true;
        }
        else
            return false;
    },

    markVisible: function(min, max)
    {
         if (this.context.markExecutableLinesTimeout)
         {
             this.context.clearTimeout(this.context.markExecutableLinesTimeout);
             delete this.context.markExecutableLinesTimeout;
         }
            if (FBTrace.DBG_LINETABLE) FBTrace.dumpStack("debugger.markVisible min:"+min+" max:"+max+"\n");
         this.context.markExecutableLinesTimeout = this.context.setTimeout(bindFixed(function delayMarkExecutableLines()
         {
             if (FBTrace.DBG_LINETABLE) FBTrace.sysout("debugger.delayMarkExecutableLines min:"+min+" max:"+max+"\n");
             this.markExecutableLines(this.selectedSourceBox, ((min > 0)? min : 1), max);
         }, this));
    },


});

function loadScriptLines(sourceFile, context)
{
    if (sourceFile.source)
        return sourceFile.source;
    else
        return context.sourceCache.load(sourceFile.href);
}

function appendScriptLines(lines, min, max, maxLineNoChars, panelNode)
{
    var html = getSourceLineRange(lines, min, max, maxLineNoChars);
    appendInnerHTML(panelNode, html);
}

// ************************************************************************************************

Firebug.Rep = domplate(
{
    className: "",
    inspectable: true,

    supportsObject: function(object, type)
    {
        return false;
    },

    inspectObject: function(object, context)
    {
        context.chrome.select(object);
    },

    browseObject: function(object, context)
    {
    },

    persistObject: function(object, context)
    {
    },

    getRealObject: function(object, context)
    {
        return object;
    },

    getTitle: function(object)
    {
        var label = safeToString(object);

        var re = /\[object (.*?)\]/;
        var m = re.exec(label);
        return m ? m[1] : label;
    },

    getTooltip: function(object)
    {
        return null;
    },

    getContextMenuItems: function(object, target, context)
    {
        return [];
    },

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * *
    // Convenience for domplates

    STR: function(name)
    {
        return $STR(name);
    },

    cropString: function(text)
    {
        return cropString(text);
    },

    toLowerCase: function(text)
    {
        return text.toLowerCase();
    },

    plural: function(n)
    {
        return n == 1 ? "" : "s";
    }
});

// ************************************************************************************************

Firebug.ActivableModule = extend(Firebug.Module,
{
    panelName: null,
    panelBar1: $("fbPanelBar1"),
    menuButton: null,
    menuTooltip: null,
    activeContexts: null,

    initialize: function()
    {
        this.activeContexts = [];
        if (this.menuTooltip)
            this.menuTooltip.fbEnabled = true;
    },

    initContext: function(context)
    {
        // Add observers for permissions and preference changes so, activable modules
        // (net, script) can be properly updated.
        observerService.addObserver(this, "perm-changed", false);
        prefs.addObserver(this.getPrefDomain(), this, false);

        var persistedPanelState = this.syncPersistedPanelState(context, true);
        if (FBTrace.DBG_PANELS)
            FBTrace.sysout("firebug.initContext panelName "+this.panelName+" persistedPanelState.enabled "+persistedPanelState.enabled+"\n");
    },

    syncPersistedPanelState: function(context, beginOrEnd)
    {
        var persistedPanelState = getPersistedState(context, this.panelName);

        persistedPanelState.enabled = this.isEnabledForHost(FirebugChrome.getBrowserURI(context));

        if (persistedPanelState.enabled)
            this.moduleActivate(context, beginOrEnd);
        else
            this.moduleDeactivate(context, beginOrEnd);

        this.menuUpdate(context);

        return persistedPanelState;
    },

    reattachContext: function(context)
    {
        var persistedPanelState = this.syncPersistedPanelState(context, false);
    },

    showContext: function(browser, context)
    {
        var tab = this.panelBar1.getTab(this.panelName);
        var enabled = this.isEnabled(context);
        tab.setAttribute("disabled", enabled ? "false" : "true");
    },

    destroyContext: function(context)
    {
        if (FBTrace.DBG_PANELS)
            FBTrace.sysout("firebug.destroyContext panelName "+this.panelName+"\n");
        observerService.removeObserver(this, "perm-changed");
        prefs.removeObserver(this.getPrefDomain(), this);

        this.moduleDeactivate(context, true);
    },

    moduleActivate: function(context, init)
    {
        if (FBTrace.DBG_PANELS)
            FBTrace.sysout("moduleActivate "+this.getPrefDomain()+" isEnabled:"+this.isEnabled(context)+"\n");
        if (this.isEnabled(context))
            return;

        if (this.activeContexts.length == 0)
            this.onFirstModuleActivate(context, init);

        this.activeContexts.push(context);

        this.onModuleActivate(context, init);
    },

    moduleDeactivate: function(context, destroy)
    {
        if (FBTrace.DBG_PANELS)
            FBTrace.sysout("moduleDeactivate "+this.getPrefDomain()+" isEnabled:"+this.isEnabled(context)+"\n");

        if (!this.isEnabled(context))
            return;

        var i = this.activeContexts.indexOf(context);
        if (i != -1)
            this.activeContexts.splice(i, 1);
        else
        {
            FBTrace.sysout("moduleDeactivate "+context.window.location +" not in activeContexts\n");
            return;
        }

        this.onModuleDeactivate(context, destroy);

        if (!destroy)
        {
            this.disablePanel(context);

            var panelBar1 = $("fbPanelBar1");
            var panel = context.getPanel(this.panelName, true);

            // Refresh the panel only if it's currently selected.
            if (panel && panelBar1.selectedPanel == panel)
            {
                var state = Firebug.getPanelState(panel);
                panel.show(state);
            }
        }

        if (this.activeContexts.length == 0)
            this.onLastModuleActivate(context, destroy);
    },

    onFirstModuleActivate: function(context, init)
    {
        // Just before onModuleActivate, no previous activecontext
    },

    onModuleActivate: function(context, init)
    {
        // Module activation code. Just added to activeContexts
    },

    onModuleDeactivate: function(context, destroy)
    {
        // Module deactivation code. Just removed from activeContexts
    },

    onLastModuleActivate: function(context, init)
    {
        // Just after onModuleDeactivate, no remaining activecontext
    },

    isEnabled: function(context)
    {
        if (!context)
            return false;

        return (this.activeContexts.indexOf(context) != -1);
    },

    wasEnabled: function(context)
    {
        if (!context)
            return false;

        var persistedPanelState = getPersistedState(context, this.panelName);
        if (persistedPanelState)
            return persistedPanelState.enabled;

        return false;
    },

    getPrefDomain: function()
    {
        if (!this.prefDomain)
            this.prefDomain = Firebug.prefDomain + "." + this.panelName;
         return this.prefDomain;
    },

    isEnabledForHost: function(an_nsIURI)
    {
        if (an_nsIURI)
        {
            var prefDomain = this.getPrefDomain();

            if ( !(an_nsIURI instanceof Ci.nsIURI) )
            {
                an_nsIURI = ioService.newURI(an_nsIURI, null, null);

                if (FBTrace.DBG_PANELS)
                    FBTrace.sysout(prefDomain+".isEnabledForHost false uri: "+(an_nsIURI.host?an_nsIURI.host:an_nsIURI)+"\n");
            }

            // Permission-manager can't be used for local URIs. So, check the URI
            // and use preferences in such a case.
            var enabled;
            if (!isLocalURL(an_nsIURI.spec))
                enabled = permissionManager.testPermission(an_nsIURI, prefDomain);
            else
                enabled = Firebug.getPref(prefDomain, "enableLocalFiles");

            return enabled;
        }

        return false;
    },

    setEnabledForHost: function(context, enable)
    {
        var location = FirebugChrome.getBrowserURI(context);
        var prefDomain = this.getPrefDomain();

        if (FBTrace.DBG_PANELS)
            FBTrace.sysout("firebug.setEnabledForHost enable:"+enable+" prefDomain:"+prefDomain+" for "+location.spec+"\n");

        if (this.isEnabledForHost(location) == enable)
        {
            if (FBTrace.DBG_PANELS)
                 FBTrace.sysout("firebug.setEnabledForHost attempt to change to same state: "+enable+"\n");
        }

        if (!isLocalURL(location.spec))
        {
            permissionManager.remove(location.host, prefDomain);  // API junk
            if (enable)
                permissionManager.add(location, prefDomain, permissionManager.ALLOW_ACTION);
        }
        else
        {
            Firebug.setPref(prefDomain, "enableLocalFiles", enable);
        }
    },

    observe: function(subject, topic, data)
    {
        try
        {
            // This methods observes two events:
            // perm-changed - fired when permissions are changed.
            // nsPref:changed - fired when preferences are changed.
            if (FBTrace.DBG_PANELS)
            {
                if ((topic != "perm-changed") && (topic != "nsPref:changed"))
                    FBTrace.sysout("firebug.ActivableModule.observe UNKNOWN topic "+topic+" data: "+data+"\n");
                else
                    FBTrace.sysout("firebug.ActivableModule.observe topic "+topic+" data: "+data+"\n");
            }

            if (topic == 'perm-changed')
            {
                if (subject instanceof Ci.nsIPermission)
                {
                    if (FBTrace.DBG_PANELS)
                        FBTrace.sysout("firebug.ActivableModule.observe subject:"+subject+" topic "+topic+" data: "+data+"\n");
                    var host = subject.host;
                    var prefDomain = subject.type;  // eg extensions.firebug.script
                    dispatch(modules, "activationChange", [host, prefDomain, data]); // data will be 'added' or 'deleted'
                }
                else
                {
                    if (FBTrace.DBG_ERRORS)
                        FBTrace.dumpProperties("!firebug.observe perm-changed subject is not an nsIPermission", subject);
                }
            }
            else if (topic == "nsPref:changed")
            {
                var prefDomain = this.getPrefDomain();
                if (data == prefDomain + ".enableLocalFiles")
                {
                    if (FBTrace.DBG_PANELS)
                        FBTrace.sysout("firebug.ActivableModule.observe subject:"+subject+" topic "+topic+" data: "+data+"\n");
                    dispatch(modules, "activationChange", [null, prefDomain, data]);
                }
            }
        }
        catch (exc)
        {
            if (FBTrace.dumpProperties)
                FBTrace.dumpProperties("firebug.observe permisssions FAILS", exc);
        }
    },

    activationChange: function(host, prefDomain, direction)
    {
        if (FBTrace.DBG_PANELS)
            FBTrace.sysout("firebug.activationChange for this.getPrefDomain:"+this.getPrefDomain()+" host:"+host+" prefDomain: "+prefDomain+" direction:"+ direction+"\n");

        if (prefDomain == this.getPrefDomain())
        {
            var module = this;
            TabWatcher.iterateContexts(
                function changeActivation(context)
                {
                    try
                    {
                        var location = context.window.location;

                        if (FBTrace.DBG_PANELS)
                            FBTrace.sysout("trying "+ location.href +"=="+ host+((location.host.indexOf(host)!=-1)?" ***FOUND***":" no match")+"\n");

                        if (isLocalURL(location.href))
                            module.syncPersistedPanelState(context, false);
                        else if (location.host.indexOf(host) != -1)
                            module.syncPersistedPanelState(context, false);
                    }
                    catch (exc)
                    {
                        if (FBTrace.DBG_ERRORS)
                            FBTrace.dumpProperties("firebug.activationChange changeActivation fails for "+location, location);
                    }
                }
            );
        }
    },

    enablePanel: function(context)
    {
        var panel = context.getPanel(this.panelName);

        var persistedPanelState = getPersistedState(panel.context, panel.name);
        persistedPanelState.enabled = true;

        var tab = this.panelBar1.getTab(panel.name);
        tab.removeAttribute("disabled");
    },

    disablePanel: function(context)
    {
        var panel = context.getPanel(this.panelName, true);
        if (!panel)
            return;

        var persistedPanelState = getPersistedState(context, panel.name);
        persistedPanelState.enabled = false;

        var tab = this.panelBar1.getTab(panel.name);
        tab.setAttribute("disabled", "true");

        panel.clear();
    },

    // Menu in toolbar.
    onStateMenuTooltipShowing: function(tooltip, context)
    {
        if (!this.menuTooltip)
            return false;

        if (this.menuTooltip.fbEnabled)
            this.menuTooltip.label = $STR(this.panelName + "." + "PermMenuTooltip");

        return this.menuTooltip.fbEnabled;
    },

    onStateMenuCommand: function(event, context)
    {
        var menu = event.target;
        this.setEnabledForHost(context, (menu.value == "enable"));
    },

    onStateMenuPopupShowing: function(menu, context)
    {
        if (this.menuTooltip)
            this.menuTooltip.fbEnabled = false;

        var items = menu.getElementsByTagName("menuitem");
        var value = this.menuButton.value;

        var location = FirebugChrome.getBrowserURI(context);
        for (var i=0; i<items.length; i++)
        {
            var option = items[i].value;
            if (!option)
                continue;

            if (option == value)
                items[i].setAttribute("checked", "true");

            items[i].label = this.getMenuLabel(option, location);
        }

        return true;
    },

    onStateMenuPopupHiding: function(tooltip, context)
    {
        if (this.menuTooltip)
            this.menuTooltip.fbEnabled = true;

        return true;
    },

    menuUpdate: function(context)
    {
        var value = "disable";
        if (this.isEnabled(context))
            value = "enable";

        this.menuButton.value = value;

        var location = FirebugChrome.getBrowserURI(context);
        this.menuButton.label = this.getMenuLabel(value, location, true);
        this.menuButton.removeAttribute("disabled");
        this.menuButton.setAttribute("value", value);
    },

    getMenuLabel: function (option, location, shortened)
    {
        var label = "";
        switch (option)
        {
        case "disable":
            label = (shortened) ? "DisableShort" : "Disable";
            break;

        case "enable":
            if (isSystemURL(location.spec))
                label = "SystemPagesEnable";
            else if (!getURIHost(location))
                label = "LocalFilesEnable";
            else
                label = "HostEnable";

            if (shortened)
                label = "EnableShort";
            break;
        }

        if (!label)
            return null;

        label = this.panelName + "." + label;
        return $STRF(label, [getURIHost(location)]);
    }
});

// ************************************************************************************************

Firebug.ModuleManagerPage = domplate(Firebug.Rep,
{
    tag:
        DIV({class: "moduleManagerBox"},
            H1({class: "moduleManagerHead"},
                $STR("moduleManager.title")
            ),
            P({class: "moduleManagerDescription"},
                $STR("moduleManager.description")
            ),
            TABLE({class: "activableModuleTable", cellpadding: 0, cellspacing: 0},
                TBODY(
                    FOR("module", "$modules",
                        TR({class: "activableModuleRow", _repObject: "$module", 
                            $panelDisabled: "$module|isModuleDisabled"},
                            TD({class: "activableModuleCell activableModuleState"},
                                INPUT({class: "activableModuleCheckBox", type: "checkbox",
                                    onchange: "$onModuleStateChanged"})
                            ),
                            TD({class: "activableModuleCell activableModuleName",
                                onclick: "$onModuleNameClick"}, "$module|getModuleName"),
                            TD({class: "activableModuleCell activableModuleDesc"}, "$module|getModuleDesc"),
                            TD({class: "activableModuleCell"}, "$module|getModuleState")
                        )
                    )
                )
            ),
            DIV({class: "moduleManagerRow", style: "align:right"},
                BUTTON({class: "moduleMangerApplyButton", onclick: "$onEnable"},
                    SPAN("$enableHostLabel")
                )
            )
         ),

    getModuleName: function(module)
    {
        return module.panelName;
    },

    getModuleDesc: function(module)
    {
        return module.description;
    },

    getModuleState: function(module)
    {
        var enabled = module.isEnabled(this.context);
        return enabled ? "" : $STR("moduleManager.disabled");
    },

    isModuleDisabled: function(module)
    {
        return !module.isEnabled(this.context);
    },

    isModuleEnabled: function(module)
    {
        return module.isEnabled(this.context);
    },

    onModuleStateChanged: function(event)
    {
        this.updateApplyButton();
    },

    updateApplyButton: function()
    {
        var disabled = true;
        for (var i=0; i<this.inputs.length; i++)
        {
            var input = this.inputs[i];
            if (input.checked != input.originalValue)
            {
                disabled = false;
                break;
            }
        }

        this.applyButton.disabled = disabled;
    },

    onModuleNameClick: function(event)
    {
        var moduleRow = Firebug.getRepNode(event.target);
        var checkBox = getElementByClass(moduleRow, "activableModuleCheckBox");
        checkBox.checked = checkBox.checked ? false : true;

        this.updateApplyButton();
    },

    onEnable: function(event)
    {
        for (var i=0; i<this.inputs.length; i++)
        {
            var input = this.inputs[i];
            if (!hasClass(input, "activableModuleCheckBox"))
                continue;

            var model = Firebug.getRepObject(input);
            if (input.checked)
                this.enableModule(model);
            else
                this.disableModule(model);
        }

        this.refresh();
    },

    enableModule: function(module)
    {
        if (!this.isModuleEnabled(module)) 
            module.setEnabledForHost(this.context, true);
    },

    disableModule: function(module)
    {
        if (this.isModuleEnabled(module)) 
            module.setEnabledForHost(this.context, false);
    },

    show: function(panel)
    {
        this.context = panel.context;
        this.panelNode = panel.panelNode;
        this.refresh();
    },

    hide: function(panel)
    {
        if (this.box)
            this.box.setAttribute("collapsed", "true");
    },

    refresh: function()
    {
        var location = FirebugChrome.getBrowserURI(this.context);
        var hostURI = getURIHost(location);
        hostURI = hostURI ? hostURI : $STR("moduleManager.localfiles");

        // Prepare arguments for the template (list of activableModules and
        // title for the apply button).
        var args = {
            modules: activableModules,
            enableHostLabel: $STRF("moduleManager.apply.title", [hostURI])
        };

        // Render panel HTML
        this.box = this.tag.replace(args, this.panelNode, this);
        this.panelNode.scrollTop = 0;

        // Update value of all checkboxes 
        // xxxHonza: is there a better domplate way how to set default value for a checkbox?
        this.inputs = this.panelNode.getElementsByTagName("input");
        for (var i=0; i<this.inputs.length; i++)
        {
            var input = this.inputs[i];
            if (!hasClass(input, "activableModuleCheckBox"))
                continue;

            var model = Firebug.getRepObject(input);
            input.checked = input.originalValue = this.isModuleEnabled(model);
        }

        this.applyButton = getElementByClass(this.panelNode, "moduleMangerApplyButton");
        this.applyButton.disabled = true;
    }
});

// ************************************************************************************************

}});
