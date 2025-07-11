import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';

import type * as mode from './kustoMode';
import KustoCommandHighlighter from './editorExtensions/commandHighlighter';
import KustoCommandFormatter from './editorExtensions/commandFormatter';
import { dateStringWrapper } from './editorExtensions/dateStringWrapper';
import { extend } from './extendedEditor';
import type { LanguageServiceDefaults, WorkerAccessor } from './types';
import type { LanguageSettings } from './languageServiceManager/settings';
import { themes } from './syntaxHighlighting/themes';
import { LANGUAGE_ID } from './globals';
import {
    getCslTypeNameFromClrType,
    getCallName,
    getExpression,
    getInputParametersAsCslString,
    getEntityDataTypeFromCslType,
} from './languageServiceManager/schema';
import { getRangeHtml } from './extendedGlobalApi';
import CaseInvertor from './editorExtensions/CaseInvertor';

export * from './languageServiceManager/schema';
export * from './languageServiceManager/renderInfo';
export * from './languageServiceManager/settings';
export * from './types';
export * from './extendedGlobalApi';

// --- Kusto configuration and defaults ---------

class LanguageServiceDefaultsImpl implements LanguageServiceDefaults {
    private _onDidChange = new monaco.Emitter<LanguageServiceDefaults>();
    private _languageSettings: LanguageSettings;
    // in milliseconds. For example - this is 2 minutes 2 * 60 * 1000
    private _workerMaxIdleTime: number;

    constructor(languageSettings: LanguageSettings) {
        this.setLanguageSettings(languageSettings);
        // default to never kill worker when idle.
        // reason: when killing worker - schema gets lost. We transmit the schema back to main process when killing
        // the worker, but in some extreme cases web worker runs out of memory while stringifying the schema.
        // This stems from the fact that web workers have much more limited memory that the main process.
        // An alternative solution (not currently implemented) is to just save the schema in the main process whenever calling
        // setSchema. That way we don't need to stringify the schema on the worker side when killing the web worker.
        this._workerMaxIdleTime = 0;
    }

    get onDidChange(): monaco.IEvent<LanguageServiceDefaults> {
        return this._onDidChange.event;
    }

    get languageSettings(): LanguageSettings {
        return this._languageSettings;
    }

    setLanguageSettings(options: LanguageSettings): void {
        this._languageSettings = options || Object.create(null);
        this._onDidChange.fire(this);
    }

    setMaximumWorkerIdleTime(value: number): void {
        // doesn't fire an event since no
        // worker restart is required here
        this._workerMaxIdleTime = value;
    }

    getWorkerMaxIdleTime() {
        return this._workerMaxIdleTime;
    }
}

const defaultLanguageSettings: LanguageSettings = {
    includeControlCommands: true,
    newlineAfterPipe: true,
    openSuggestionDialogAfterPreviousSuggestionAccepted: true,
    enableHover: true,
    formatter: {
        indentationSize: 4,
        pipeOperatorStyle: 'Smart',
    },
    syntaxErrorAsMarkDown: {
        enableSyntaxErrorAsMarkDown: false,
    },
    enableQueryWarnings: false,
    enableQuerySuggestions: false,
    disabledDiagnosticCodes: [],
    quickFixCodeActions: ['Change to', 'FixAll'],
    enableQuickFixes: false,
    completionOptions: { includeExtendedSyntax: false },
};

export function getKustoWorker(): Promise<WorkerAccessor> {
    return new Promise((resolve, reject) => {
        withMode((mode) => {
            mode.getKustoWorker().then(resolve, reject);
        });
    });
}

function withMode<T>(callback: (module: typeof mode) => T): Promise<T> {
    return import('./kustoMode').then(callback);
}

export const kustoDefaults = new LanguageServiceDefaultsImpl(defaultLanguageSettings);

let disposable: monaco.IDisposable;
monaco.languages.onLanguage('kusto', async () => {
    await withMode((mode) => mode.setupMode(kustoDefaults, monaco as typeof globalThis.monaco));
});

monaco.languages.register({
    id: LANGUAGE_ID,
    extensions: ['.csl', '.kql'],
});

themes.forEach(({ name, data }) => monaco.editor.defineTheme(name, data));

// Initialize kusto specific language features that don't currently have a natural way to extend using existing apis.
// Most other language features are initialized in kustoMode.ts
monaco.editor.onDidCreateEditor((editor) => {
    if (window.MonacoEnvironment?.globalAPI) {
        // hook up extension methods to editor.
        extend(editor);
    }

    // TODO: asked if there's a cleaner way to register an editor contribution. looks like monaco has an internal contribution registrar but it's no exposed in the API.
    // https://stackoverflow.com/questions/46700245/how-to-add-an-ieditorcontribution-to-monaco-editor
    new KustoCommandHighlighter(editor);

    if (isStandaloneCodeEditor(editor)) {
        new KustoCommandFormatter(editor);
        new CaseInvertor(editor);
    }

    triggerSuggestDialogWhenCompletionItemSelected(editor);
    dateStringWrapper(editor);
});

function triggerSuggestDialogWhenCompletionItemSelected(editor: monaco.editor.ICodeEditor) {
    editor.onDidChangeCursorSelection((event: monaco.editor.ICursorSelectionChangedEvent) => {
        // checking the condition inside the event makes sure we will stay up to date when kusto configuration changes at runtime.
        if (
            kustoDefaults &&
            kustoDefaults.languageSettings &&
            kustoDefaults.languageSettings.openSuggestionDialogAfterPreviousSuggestionAccepted
        ) {
            var didAcceptSuggestion =
                event.source === 'snippet' && event.reason === monaco.editor.CursorChangeReason.NotSet;
            // If the word at the current position is not null - meaning we did not add a space after completion.
            // In this case we don't want to activate the eager mode, since it will display the current selected word..
            if (!didAcceptSuggestion || editor.getModel().getWordAtPosition(event.selection.getPosition()) !== null) {
                return;
            }
            event.selection;
            // OK so now we in a situation where we know a suggestion was selected, and we want to trigger another one.
            // the only problem is that the suggestion widget itself listens to this same event in order to know it needs to close.
            // The only problem is that we're ahead in line, so we're triggering a suggest operation that will be shut down once
            // the next callback is called. This is why we're waiting here - to let all the callbacks run synchronously and be
            // the 'last' subscriber to run. Granted this is hacky, but until monaco provides a specific event for suggestions,
            // this is the best we have.
            setTimeout(() => editor.trigger('monaco-kusto', 'editor.action.triggerSuggest', {}), 10);
        }
    });
}

function isStandaloneCodeEditor(editor: monaco.editor.ICodeEditor): editor is monaco.editor.IStandaloneCodeEditor {
    return (editor as monaco.editor.IStandaloneCodeEditor).addAction !== undefined;
}

const globalApi: typeof import('./monaco.contribution') = {
    getCslTypeNameFromClrType,
    getCallName,
    getExpression,
    getInputParametersAsCslString,
    getEntityDataTypeFromCslType,
    kustoDefaults,
    getKustoWorker,
    getRangeHtml,
};

(monaco as any).languages.kusto = globalApi;

// I am not sure why this is needed, but it is. Without it, parcel production build removes this function.
export { getRangeHtml };
