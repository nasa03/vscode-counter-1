'use strict';
// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import LineCounter from './LineCounter';
import Gitignore from './Gitignore';
import * as JSONC from 'jsonc-parser';

const EXTENSION_NAME = 'VSCodeCounter';
const CONFIGURATION_SECTION = 'VSCodeCounter';
const toZeroPadString = (num: number, fig: number) => num.toString().padStart(fig, '0');

const dateToString = (date: Date) => `${date.getFullYear()}-${toZeroPadString(date.getMonth()+1, 2)}-${toZeroPadString(date.getDate(), 2)}`
                + ` ${toZeroPadString(date.getHours(), 2)}:${toZeroPadString(date.getMinutes(), 2)}:${toZeroPadString(date.getSeconds(), 2)}`;

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
    // Use the console to output diagnostic information (console.log) and errors (console.error)
    // This line of code will only be executed once when your extension is activated
    console.log(`Congratulations, your extension "${EXTENSION_NAME}" ${context.extensionPath} is now active!`);
    // The command has been defined in the package.json file
    // Now provide the implementation of the command with  registerCommand
    // The commandId parameter must match the command field in package.json
    const codeCountController = new CodeCounterController();
    context.subscriptions.push(
        codeCountController,
        vscode.commands.registerCommand('extension.vscode-counter.countInDirectory', (targetDir: vscode.Uri|undefined) => codeCountController.countInDirectory(targetDir)),
        vscode.commands.registerCommand('extension.vscode-counter.countInFile', () => codeCountController.toggleShowCounter())
    );
}
// this method is called when your extension is deactivated
export function deactivate() {
}


class CodeCounterController {
    private codeCounter: CodeCounter;
    private disposable: vscode.Disposable;
    constructor() {
        this.codeCounter = new CodeCounter();
        // subscribe to selection change and editor activation events
        let subscriptions: vscode.Disposable[] = [];
        vscode.window.onDidChangeActiveTextEditor(this.onDidChangeActiveTextEditor, this, subscriptions);
        vscode.workspace.onDidChangeConfiguration(this.onDidChangeConfiguration, this, subscriptions);
        vscode.workspace.onDidChangeTextDocument(this.onDidChangeTextDocument, this, subscriptions);
        // create a combined disposable from both event subscriptions
        this.disposable = vscode.Disposable.from(...subscriptions);
        this.codeCounter.countCurrentFile();
    }
    dispose() {
        this.disposable.dispose();
        this.codeCounter.dispose();
    }
    public countInDirectory(targetDir: vscode.Uri|undefined) {
        const dir = vscode.workspace.rootPath;
        if (targetDir !== undefined) {
            this.codeCounter.countLinesInDirectory(targetDir.fsPath);
        } else {
            const option = {
                value : dir || "",
                placeHolder: "Input Directory Path",
                prompt: "Input Directory Path. "
            };
            vscode.window.showInputBox(option).then(dirPath => {
                if (dirPath !== undefined) {
                    this.codeCounter.countLinesInDirectory(dirPath);
                    // vscode.window.showInformationMessage(`${EXTENSION_NAME} : No open workspace!`);
                }
            });

        // } else if (typeof dir === 'string') {
        //     this.codeCounter.countLinesInDirectory(dir);
        // } else {
        }
    }
    public toggleShowCounter() {
        this.codeCounter.toggleShowCounter();
        this.codeCounter.countCurrentFile();
    }
    private onDidChangeActiveTextEditor() {
        console.log('onDidChangeActiveTextEditor()');
        this.codeCounter.countCurrentFile();
    }
    private onDidChangeTextDocument() {
        console.log('onDidChangeTextDocument()');
        this.codeCounter.countCurrentFile();
    }
    private onDidChangeConfiguration() {
        console.log('onDidChangeConfiguration()');
        this.codeCounter.dispose();
        this.codeCounter = new CodeCounter();
        this.codeCounter.countCurrentFile();
    }
}

class CodeCounter {
    private outputChannel: vscode.OutputChannel|null = null;
    private statusBarItem: vscode.StatusBarItem|null = null;
    private configuration: vscode.WorkspaceConfiguration;
    private lineCounterTable: LineCounterTable;

    constructor() {
        this.configuration = vscode.workspace.getConfiguration(CONFIGURATION_SECTION);
        this.lineCounterTable = new LineCounterTable(this.configuration);
        if (this.getConf('showInStatusBar', false)) {
            this.toggleShowCounter();
        }
    }
    dispose() {
        if (this.statusBarItem !== null) {
            this.statusBarItem.dispose();
        }
        if (this.outputChannel !== null) {
            this.outputChannel.dispose();
        }
    }
    private getConf<T>(section: string, defaultValue: T): T {
        return this.configuration.get(section, defaultValue);
    }
    private toOutputChannel(text: string) {
        if (this.outputChannel === null) {
            this.outputChannel = vscode.window.createOutputChannel(EXTENSION_NAME);
        }
        this.outputChannel.show();
        this.outputChannel.appendLine(text);
    }
    private toStatusBar(getText: () => string) {
        if (this.statusBarItem !== null) {
            this.statusBarItem.show();
            this.statusBarItem.text = getText();
        }
    }
    public toggleShowCounter() {
        if (this.statusBarItem === null) {
            this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
        } else {
            this.statusBarItem.hide();
            this.statusBarItem.dispose();
            this.statusBarItem = null;
        }
        this.configuration.update('showInStatusBar', this.statusBarItem !== null);
    }
    public countLinesInDirectory(dir: string) {
        console.log(`countLinesInDirectory : ${dir}`);
        const confFiles = vscode.workspace.getConfiguration("files");
        const workspaceDir = vscode.workspace.rootPath || `.${path.sep}`;
        const outputDir = path.resolve(workspaceDir, this.getConf('outputDirectory', ''));
        const ignoreUnsupportedFile = this.getConf('ignoreUnsupportedFile', true);
        const includes = this.getConf<Array<string>>('include', ['**/*']);
        const excludes = this.getConf<Array<string>>('exclude', []);

        excludes.push(outputDir);
        if (this.getConf('useFilesExclude', true)) {
            excludes.push(...Object.keys(confFiles.get<object>('exclude', {})));
        }
        excludes.push('.gitignore');
        const encoding = confFiles.get('encoding', 'utf8');
        const endOfLine = confFiles.get('eol', '\n');
        console.log(`encoding : ${encoding}`);
        console.log(`includes : ${includes.join(',')}`);
        console.log(`excludes : ${excludes.join(',')}`);

        vscode.workspace.findFiles(`{${includes.join(',')}}`, `{${excludes.join(',')}}`).then((files: vscode.Uri[]) => {
            new Promise((resolve: (p: string[])=> void, reject: (p: string[]) => void) => {
                const filePathes = files.map(uri => uri.fsPath).filter(p => !path.relative(dir, p).startsWith('..'));
                console.log(`target : ${filePathes.length} files`);
                // filePathes.forEach(p=> console.log(p));
                if (this.getConf('useGitignore', true)) {
                    vscode.workspace.findFiles('**/.gitignore', '').then((gitignoreFiles: vscode.Uri[]) => {
                        gitignoreFiles.forEach(f => console.log(`use gitignore : ${f.fsPath}`));
                        const gitignores = new Gitignore('').merge(...gitignoreFiles.map(uri => uri.fsPath).sort().map(p => new Gitignore(fs.readFileSync(p, 'utf8'), path.dirname(p))));
                        // console.log(`=========================================\ngitignore rules\n${gitignores.debugString}`);
                        resolve(filePathes.filter(p => gitignores.excludes(p)));
                    });
                } else {
                    resolve(filePathes);
                }
            }).then((filePathes: string[]) => {
                console.log(`target : ${filePathes.length} files`);
                // filePathes.forEach(p=> console.log(p));
                return new Promise((resolve: (value: ResultTable)=> void, reject: (value: ResultTable) => void) => {
                    const results = new ResultTable();
                    results.targetDirPath = dir;
                    let fileCount = 0;
                    filePathes.forEach(filepath => {
                        const lineCounter = this.lineCounterTable.getByPath(filepath);
                        if (lineCounter !== undefined) {
                            fs.readFile(filepath, encoding, (err, data) => {
                                ++fileCount;
                                if (err) {
                                    this.toOutputChannel(`"${filepath}" Read Error : ${err.message}.`);
                                    results.appendEmpty(filepath, '(Read Error)');
                                } else {
                                    results.appendResult(filepath, lineCounter.name, lineCounter.count(data));
                                }
                                if (fileCount === filePathes.length) {
                                    resolve(results);
                                }
                            });
                        } else {
                            if (!ignoreUnsupportedFile) {
                                results.appendEmpty(filepath, '(Unsupported)');
                            }
                            ++fileCount;
                            if (fileCount === filePathes.length) {
                                resolve(results);
                            }
                        }
                    });
                });
            }).then((results: ResultTable) => {
                console.log(`count ${results.fileResults.length} files`);
                if (results.fileResults.length <= 0) {
                    vscode.window.showInformationMessage(`${EXTENSION_NAME} There was no target file.`);
                    return;
                }
                const previewType = this.getConf<string>('outputPreviewType', '');
                console.log(`OutputDir : ${outputDir}`);
                makeDirectories(outputDir);
                if (this.getConf('outputAsText', true)) {
                    const promise = writeTextFile(path.join(outputDir, 'results.txt'), results.toTextLines().join(endOfLine));
                    if (previewType === 'text') {
                        promise.then(ofilename => showTextFile(ofilename))
                            .then(editor => console.log(`output file : ${editor.document.fileName}`))
                            .catch(err => console.error(err));
                    } else {
                        promise.then(ofilename => console.log(`output file : ${ofilename}`))
                            .catch(err => console.error(err));
                    }
                }
                if (this.getConf('outputAsCSV', true)) {
                    const promise = writeTextFile(path.join(outputDir, 'results.csv'), results.toCSVLines().join(endOfLine));
                    if (previewType === 'csv') {
                        promise.then(ofilename => showTextFile(ofilename))
                            .then(editor => console.log(`output file : ${editor.document.fileName}`))
                            .catch(err => console.error(err));
                    } else {
                        promise.then(ofilename => console.log(`output file : ${ofilename}`))
                            .catch(err => console.error(err));
                    }
                }
                if (this.getConf('outputAsMarkdown', true)) {
                    const promise = writeTextFile(path.join(outputDir, 'results.md'), results.toMarkdownLines().join(endOfLine));
                    if (previewType === 'markdown') {
                        promise.then(ofilename => vscode.commands.executeCommand("markdown.showPreview", vscode.Uri.file(ofilename)))
                            .catch(err => console.error(err));
                    } else {
                        promise.then(ofilename => console.log(`output file : ${ofilename}`))
                            .catch(err => console.error(err));
                    }
                }
            });
        });
    }
    public countCurrentFile() {
        this.toStatusBar(() => {
            // Get the current text editor
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                return `${EXTENSION_NAME}:Unsupported`;
            }
            const doc = editor.document;
            const lineCounter = this.lineCounterTable.getByName(doc.languageId) || this.lineCounterTable.getByPath(doc.uri.fsPath);
            console.log(`${path.basename(doc.uri.fsPath)}: ${JSON.stringify(lineCounter)})`);
            if (lineCounter !== undefined) {
                const result = lineCounter.count(doc.getText());
                return `Code:${result.code} Comment:${result.comment} Blank:${result.blank} Total:${result.code+result.comment+result.blank}`;
            } else {
                return `${EXTENSION_NAME}:Unsupported`;
            }
        });
    }
}


class Result {
    public filename: string;
    public language: string;
    public errorMessage: string;
    public code = 0;
    public comment = 0;
    public blank = 0;
    get total(): number {
        return this.code + this.comment + this.blank;
    }
    constructor(filename: string, language: string, errorMessage = '') {
        this.filename = filename;
        this.language = language;
        this.errorMessage = errorMessage;
    }
    public append(value: {code:number, comment:number, blank:number}) {
        this.code += value.code;
        this.comment += value.comment;
        this.blank += value.blank;
        return this;
    }
}
class Statistics {
    public name: string;
    public files = 0;
    public code = 0;
    public comment = 0;
    public blank = 0;
    get total(): number {
        return this.code + this.comment + this.blank;
    }
    constructor(name: string) {
        this.name = name;
    }
    public append(value: {code:number, comment:number, blank:number}) {
        this.files++;
        this.code += value.code;
        this.comment += value.comment;
        this.blank += value.blank;
        return this;
    }
}
class ResultTable {
    public targetDirPath: string = ".";
    public fileResults: Result[] = [];
    public dirResultTable = new Map<string, Statistics>();
    public langResultTable = new Map<string, Statistics>();
    public total = new Statistics('Total');

    public appendResult(filepath: string, language: string, value: {code:number, comment:number, blank:number}) {
        const result = new Result(path.relative(this.targetDirPath, filepath), language).append(value);
        this.fileResults.push(result);
        let parent = path.dirname(result.filename);
        while (parent.length > 0) {
            getOrSetFirst(this.dirResultTable, parent, () => new Statistics(parent)).append(value);
            const p = path.dirname(parent);
            if (p === parent) {
                break;
            }
            parent = p;
        }
        getOrSetFirst(this.langResultTable, language, () => new Statistics(language)).append(value);
        this.total.append(value);
    }
    public appendError(filepath: string, language: string, err:NodeJS.ErrnoException) {
        this.fileResults.push(new Result(path.relative(this.targetDirPath, filepath), language, 'Error:' + err.message));
    }
    public appendEmpty(filepath: string, language: string) {
        this.fileResults.push(new Result(path.relative(this.targetDirPath, filepath), language));
    }
    public toCSVLines() {
        const languages = [...this.langResultTable.keys()];
        return [
            `filename, language, ${languages.join(', ')}, comment, blank, total`,
            ...this.fileResults.sort((a,b) => a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0)
                .map(v => `${v.filename}, ${v.language}, ${languages.map(l => l === v.language ? v.code : 0).join(', ')}, ${v.comment}, ${v.blank}, ${v.total}`),
            `Total, -, ${[...this.langResultTable.values()].map(r => r.code).join(', ')}, ${this.total.comment}, ${this.total.blank}, ${this.total.total}`
        ];
    }
    public toTextLines() {
        class Formatter {
            private columnInfo: {title:string, width:number}[];
            constructor(...columnInfo: {title:string, width:number}[]) {
                this.columnInfo = columnInfo;
            }
            public get lineSeparator() {
                return '+-' + this.columnInfo.map(i => '-'.repeat(i.width)).join('-+-') + '-+';
            }
            get headerLines() {
                return [this.lineSeparator, '| ' + this.columnInfo.map(i => i.title.padEnd(i.width)).join(' | ') + ' |', this.lineSeparator];
            }
            get footerLines() {
                return [this.lineSeparator];
            }
            public line(...data: (string|number|boolean)[]) {
                return '| ' + data.map((d, i) => {
                    if (typeof d === 'string') {
                        return d.padEnd(this.columnInfo[i].width);
                    } else {
                        return d.toString().padStart(this.columnInfo[i].width);
                    }
                }).join(' | ') + ' |';
            }
        }
        const maxNamelen = Math.max(...this.fileResults.map(res => res.filename.length));
        const maxLanglen = Math.max(...[...this.langResultTable.keys()].map(l => l.length));
        const resultFormat = new Formatter({title:'filename', width:maxNamelen}, {title:'language', width:maxLanglen}, 
            {title:'code', width:10}, {title:'comment', width:10}, {title:'blank', width:10}, {title:'total', width:10});
        const dirFormat = new Formatter({title:'path', width:maxNamelen}, {title:'files', width:10}, 
            {title:'code', width:10}, {title:'comment', width:10}, {title:'blank', width:10}, {title:'total', width:10});
        const langFormat = new Formatter({title:'language', width:maxLanglen}, {title:'files', width:10}, 
            {title:'code', width:10}, {title:'comment', width:10}, {title:'blank', width:10}, {title:'total', width:10});
        return [
            '='.repeat(resultFormat.headerLines[0].length),
            `Directory : ${this.targetDirPath}`,
            `Date : ${dateToString(new Date())}`,
            // `Total : code: ${this.total.code}, comment : ${this.total.comment}, blank : ${this.total.blank}, all ${this.total.total} lines`,
            `Total : ${this.total.code} codes, ${this.total.comment} comments, ${this.total.blank} blanks, all ${this.total.total} lines`,
            '',
            'Languages',
            ...langFormat.headerLines, 
            ...[...this.langResultTable.values()].sort((a,b) => b.code - a.code)
                .map(v => langFormat.line(v.name, v.files, v.code, v.comment, v.blank, v.total)),
            ...langFormat.footerLines, 
            '',
            'Directories',
            ...dirFormat.headerLines, 
            ...[...this.dirResultTable.values()].sort((a,b) => b.code - a.code)
                .map(v => dirFormat.line(v.name, v.files, v.code, v.comment, v.blank, v.total)),
            ...dirFormat.footerLines, 
            '',
            'Files',
            ...resultFormat.headerLines, 
            ...this.fileResults.sort((a,b) => a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0)
                .map(v => resultFormat.line(v.filename, v.language, v.code, v.comment, v.blank, v.total)),
            resultFormat.line('Total', '', this.total.code, this.total.comment, this.total.blank, this.total.total),
            ...resultFormat.footerLines, 
        ];
    }
    public toMarkdownLines() {
        const dir = this.targetDirPath;
        class MarkdownFormatter {
            private columnInfo: {title:string, format:string}[];
            constructor(...columnInfo: {title:string, format:string}[]) {
                this.columnInfo = columnInfo;
            }
            get lineSeparator() {
                return '| ' + this.columnInfo.map(i => (i.format === 'number') ? '---:' : ':---').join(' | ') + ' |';
            }
            get headerLines() {
                return ['| ' + this.columnInfo.map(i => i.title).join(' | ') + ' |', this.lineSeparator];
            }
            public line(...data: (string|number|boolean)[]) {
                return '| ' + data.map((d, i) => (typeof d !== 'string') ? d.toString() : (this.columnInfo[i].format === 'uri') ? `[${d}](${vscode.Uri.file(path.join(dir, d))})` : d).join(' | ') + ' |';
            }
        }
        const resultFormat = new MarkdownFormatter({title:'filename', format:'uri'}, {title:'language', format:'string'}, 
            {title:'code', format:'number'}, {title:'comment', format:'number'}, {title:'blank', format:'number'}, {title:'total', format:'number'});
        const dirFormat = new MarkdownFormatter({title:'path', format:'string'}, {title:'files', format:'number'}, 
            {title:'code', format:'number'}, {title:'comment', format:'number'}, {title:'blank', format:'number'}, {title:'total', format:'number'});
        const langFormat = new MarkdownFormatter({title:'language', format:'string'}, {title:'files', format:'number'}, 
            {title:'code', format:'number'}, {title:'comment', format:'number'}, {title:'blank', format:'number'}, {title:'total', format:'number'});
    
        return [
            `# ${dir}`,
            '',
            `Date : ${dateToString(new Date())}`,
            '',
            `Total : ${this.total.code} codes, ${this.total.comment} comments, ${this.total.blank} blanks, all ${this.total.total} lines`,
            '',
            '## Languages',
            ...langFormat.headerLines, 
            ...[...this.langResultTable.values()].sort((a,b) => b.code - a.code)
                .map(v => langFormat.line(v.name, v.files, v.code, v.comment, v.blank, v.total)),
            '',
            '## Directories',
            ...dirFormat.headerLines, 
            // ...[...dirResultTable.values()].sort((a,b) => b.code - a.code)
            ...[...this.dirResultTable.values()].sort((a,b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
                .map(v => dirFormat.line(v.name, v.files, v.code, v.comment, v.blank, v.total)),
            '',
            '## Files',
            ...resultFormat.headerLines, 
            ...this.fileResults.sort((a,b) => a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0)
                .map(v => resultFormat.line(v.filename, v.language, v.code, v.comment, v.blank, v.total)),
        ];
    }
}
class LineCounterTable {
    private langIdTable: Map<string, LineCounter>;
    private aliasTable: Map<string, LineCounter>;
    private fileextRules: Map<string, LineCounter>;
    private filenameRules: Map<string, LineCounter>;

    constructor(conf: vscode.WorkspaceConfiguration) {
        this.langIdTable = new Map<string, LineCounter>();
        this.aliasTable = new Map<string, LineCounter>();
        this.fileextRules = new Map<string, LineCounter>();
        this.filenameRules = new Map<string, LineCounter>();
        const confJsonTable = new Map<string, object>();

        vscode.extensions.all.forEach(ex => {
            // console.log(JSON.stringify(ex.packageJSON));
            const contributes = ex.packageJSON.contributes;
            if (contributes !== undefined) {
                const languages = contributes.languages;
                if (languages !== undefined) {
                    languages.forEach((lang:any) => {
                        const lineCounter = getOrSetFirst(this.langIdTable, lang.id, () => new LineCounter(lang.id));
                        lineCounter.addAlias(lang.aliases);
                        if (lang.aliases !== undefined && lang.aliases.length > 0) {
                            lang.aliases.forEach((alias:string) => {
                                this.aliasTable.set(alias, lineCounter);
                            });
                        }
                        const confpath = lang.configuration ? path.join(ex.extensionPath, lang.configuration) : "";
                        if (confpath.length > 0) {
                            console.log(`language conf file: ${confpath}`);
                            const v = getOrSetFirst(confJsonTable, confpath, () => JSONC.parse(fs.readFileSync(confpath, "utf8")));
                            lineCounter.addCommentRule(v.comments);
                        }
                        if (lang.extensions !== undefined) {
                            (lang.extensions as Array<string>).forEach(ex => this.fileextRules.set(ex, lineCounter));
                        }
                        if (lang.filenames !== undefined) {
                            (lang.filenames as Array<string>).forEach(ex => this.filenameRules.set(ex, lineCounter));
                        }
                    });
                }
            }
        });
        class BlockPattern {
            public types: string[] = [];
            public patterns: string[][] = [];
        }
        conf.get< Array<BlockPattern> >('blockComment', []).forEach(patterns => {
            console.log(JSON.stringify(patterns));
            patterns.types.forEach(t => {
                this.addBlockStringRule(t, ...patterns.patterns.map(pat => { return {begin: pat[0], end: pat[1]}; }));
            });
        });

        // console.log(`confJsonTable : ${confJsonTable.size}  =======================================================================`);
        // confJsonTable.forEach((v, n) => { console.log(`${n}:\n ${JSON.stringify(v)}`); });
        // console.log(`this.filenameRules : ${this.filenameRules.size}  =======================================================================`);
        // this.filenameRules.forEach((v, n) => { console.log(`${n}\t ${JSON.stringify(v)}`); });
        // console.log(`this.fileextRules : ${this.fileextRules.size}  =======================================================================`);
        // this.fileextRules.forEach((v, n) => { console.log(`${n}\t ${JSON.stringify(v)}`); });
        // console.log(`this.langIdTable : ${this.langIdTable.size}  =======================================================================`);
        // this.langIdTable.forEach((v, n) => { console.log(`${n}\t ${JSON.stringify(v)}`); });
        // console.log(`this.aliasTable : ${this.aliasTable.size}  =======================================================================`);
        // this.aliasTable.forEach((v, n) => { console.log(`${n}\t ${JSON.stringify(v)}`); });
    }
    public getByName(langName: string) {
        return this.langIdTable.get(langName) || this.aliasTable.get(langName);
    }
    public getByPath(filePath: string) {
        return this.fileextRules.get(filePath) || this.fileextRules.get(path.extname(filePath)) || this.filenameRules.get(path.basename(filePath));
    }
    public addBlockStringRule(id: string, ...tokenPairs: {begin:string,end:string}[]) {
        const lineCounter = this.getByName(id) || this.getByPath(id);
        if (lineCounter) {
            console.log(`${id} : ${tokenPairs.map(t => t.begin + t.end).join('|')} to LineCounter: ${lineCounter.name}`);
            lineCounter.addBlockStringRule(...tokenPairs);
        } 
    }
}



function getOrSetFirst<K,V>(map: Map<K,V>, key: K, otherwise: () => V) {
    let v = map.get(key);
    if (v === undefined) {
        v = otherwise();
        map.set(key, v);
    }
    return v;
}
function makeDirectories(dirpath: string) {
    if (fs.existsSync(dirpath)) {
        return true;
    }
    const parent = path.dirname(dirpath);
    if ((parent !== dirpath) && makeDirectories(parent)) {
        fs.mkdirSync(dirpath);
        return true;
    } else {
        return false;
    }
}
function showTextFile(outputFilename: string) {
    console.log(`showTextFile : ${outputFilename}`);
    return new Promise((resolve: (editor: vscode.TextEditor)=> void, reject: (err: any) => void) => {
        vscode.workspace.openTextDocument(outputFilename)
        .then((doc) => {
            return vscode.window.showTextDocument(doc, vscode.ViewColumn.One, true);
        }, err => {
            reject(err);
        }).then((editor) => {
            resolve(editor);
        }, err => {
            reject(err);
        });
    });
}
function writeTextFile(outputFilename: string, text: string) {
    console.log(`writeTextFile : ${outputFilename} ${text.length}B`);
    return new Promise((resolve: (filename: string)=> void, reject: (err: NodeJS.ErrnoException) => void) => {
        fs.writeFile(outputFilename, text, err => {
            if (err) {
                reject(err);
            } else {
                resolve(outputFilename);
            }
        });
    });
}