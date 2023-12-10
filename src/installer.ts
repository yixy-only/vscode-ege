/**
 * Author: wysaid
 * Date: 2021-10-08
 */

import vscode = require('vscode')
import https = require('https');
import path = require('path');
import fs = require('fs-extra');
import os = require('os');
// import * as Unzipper from 'decompress-zip';
import decompress = require('decompress');
import { RequestMsg } from './msg';
import compilers = require('./compilers');
import { ege } from './ege';
import { isWindows } from './utils';

interface RequestUrlDataResult {
    content?: string;
    error?: string;
}

export class EGEInstaller {
    pluginContext: vscode.ExtensionContext;

    egeTempDir: string;
    egeDownloadDir: string;
    egeDownloadUrl = "https://xege.org/download/ege-latest-version";
    egeDownloadedZipFile?: string;
    egeLatestVersion?: string;
    egeInstallerDir: string;
    egeIncludeDir: string;
    egeLibsDir: string;
    egeDemoDir: string;

    /// builtin bundles
    egeBundleDir: string;

    progressHandle?: RequestMsg;
    installationCancelled: boolean = false;

    compilerHandle?: compilers.Compilers;

    constructor(context: vscode.ExtensionContext) {
        //@type {vscode.ExtensionContext}
        this.pluginContext = context;
        this.egeTempDir = path.join(os.tmpdir(), this.pluginContext.extension.id);
        console.log("The ege plugin storage path is: " + this.egeTempDir);
        this.egeDownloadDir = path.join(this.egeTempDir, "Download");
        this.egeInstallerDir = path.join(this.egeTempDir, "Install");
        this.egeIncludeDir = path.join(this.egeInstallerDir, "include");
        this.egeLibsDir = path.join(this.egeInstallerDir, "lib");
        this.egeDemoDir = path.join(this.egeInstallerDir, "demo");

        /// try to extract 
        this.egeBundleDir = path.join(__dirname, "../bundle/ege_bundle");
        if (fs.existsSync(this.egeBundleDir) && fs.existsSync(path.join(this.egeBundleDir, "include", "graphics.h"))) {
            console.log("EGE: Find builtin bundle at: " + this.egeBundleDir);
        } else {
            vscode.window.showErrorMessage("EGE: builtin bundle not found at: " + this.egeBundleDir);
        }
    }

    async performInstall(needDownload?: boolean): Promise<boolean | undefined> {
        if (fs.existsSync(this.egeInstallerDir)) {
            if (isWindows()) {
                const quickPicks = [
                    {
                        label: "Use builtin EGE(20.08)",
                        description: "使用本插件内置的EGE(20.08)完成安装 (推荐)",
                        picked: true
                    },
                    {
                        label: "Download the latest version from https://xege.org",
                        description: "从官网下载最新版本并安装",
                        picked: false
                    }];

                const value = await vscode.window.showQuickPick(quickPicks, {
                    title: "EGE: Existing installation detected, choose actions you want",
                    canPickMany: false
                });

                if (value) {
                    const index = quickPicks.indexOf(value);

                    if (index >= 0) {
                        this.clearPluginCache();

                        /// pass true to trigger download.
                        await this.performInstall(index === 1);
                    } else {
                        console.log("EGE: PerformInstall cancelled");
                        return;
                    }
                } else {
                    ege.showInfoBox("EGE: Install cancelled");
                }
                return;
            } else {
                ege.printInfo("EGE: do builtin install on non-windows platforms...");
            }
        }

        if (this.progressHandle && this.progressHandle.progressInstance) {
            ege.showErrorBox("EGE: Last progress not finished! Waiting... You can reload this window if you're waiting too long.");
            return;
        }

        if (!fs.pathExistsSync(this.egeDownloadDir)) {
            fs.mkdirpSync(this.egeDownloadDir);
        }

        if (!fs.existsSync) {
            ege.showErrorBox("EGE: Create tmp directory failed!\n");
            return false;
        }

        this.progressHandle = new RequestMsg('Install EGE', 'ege');
        this.installationCancelled = false;
        this.progressHandle.start("Fetching latest ege version...", async () => {
            /// Cancelled by user.
            this.installationCancelled = true;
            setTimeout(() => {
                delete this.progressHandle;
            }, 1);
        });

        const nextStep = async () => {
            if (this.egeDownloadedZipFile && fs.existsSync(this.egeDownloadedZipFile)) {
                this.progressHandle?.updateProgress("Perform unzipping " + this.egeDownloadedZipFile);
                if (await this.performUnzip()) {
                    this.progressHandle?.resolve();
                    vscode.window.showInformationMessage("EGE: Installer prepared, please choose a compiler!");
                    await this.performCompilerInstallation();
                } else {
                    vscode.window.showErrorMessage(`EGE: unzip ${this.egeDownloadedZipFile} failed!`);
                    fs.removeSync(this.egeInstallerDir);
                    if (this.progressHandle) {
                        this.progressHandle.reject();
                    }
                }
            } else {
                fs.mkdirpSync(this.egeInstallerDir);
                console.assert(fs.existsSync(this.egeBundleDir), "EGE: builtin bundle not found!");
                fs.copySync(this.egeBundleDir, this.egeInstallerDir, { overwrite: true });
                if (isWindows()) {
                    await this.performCompilerInstallation();
                }
            }

            if (this.progressHandle) {
                this.progressHandle.resolve();
            }
        };

        if (needDownload) {
            /// Check for the latest version.
            const exists = await this.checkExistingDownload();

            if (!exists) {
                if (!this.egeDownloadedZipFile) {
                    vscode.window.showErrorMessage("EGE: Get latest ege version failed! Make sure you're online!");
                    this.progressHandle?.reject();
                    return;
                }

                this.progressHandle?.updateProgress("Downloading " + this.egeDownloadUrl);
                if (await this.performDownload()) {
                    await nextStep();
                } else {
                    console.error("Error downloading!");
                }
            } else {
                vscode.window.showInformationMessage("EGE is already downloaded, skip downloading");
                await nextStep();
            }
        } else {
            /// extract builtin bundle.
            this.egeDownloadedZipFile = undefined;
            await nextStep();
        }
    }

    async checkExistingDownload(): Promise<boolean> {
        const v = await this.getLatestVersion();
        if (!v?.length) {
            /// 检查对应版本号的文件是否存在.
            this.egeLatestVersion = v;
            this.egeDownloadedZipFile = this.egeDownloadDir + `/ege_${v}.zip`;
            console.log("checkExistingDownload: " + this.egeDownloadedZipFile);
        } else {
            this.egeDownloadedZipFile = undefined;
        }
        return this.egeDownloadedZipFile != null && fs.existsSync(this.egeDownloadedZipFile);
    }

    async performDownload(): Promise<boolean> {
        const ret = await this.requestUrlData(this.egeDownloadUrl, this.egeDownloadedZipFile);
        return ret.error === undefined;
    }

    getCompilerHandle() {
        if (!this.compilerHandle) {
            this.compilerHandle = new compilers.Compilers(this.pluginContext);
        }
        return this.compilerHandle;
    }

    async performCompilerInstallation() {
        const compilerHandle = this.getCompilerHandle();
        const value = await compilerHandle.chooseCompilerByUser();

        if (value) {
            compilerHandle.setCompiler(value);
            compilerHandle.performInstall(value, this.egeInstallerDir, () => {
                vscode.window.showInformationMessage("EGE: Install finished!");
            });
        } else {
            ege.printError("EGE: No compiler choosed.");
        }
    }

    cleanupInstallDir() {
        if (fs.pathExistsSync(this.egeInstallerDir)) {
            fs.removeSync(this.egeInstallerDir);
        }
    }

    fixInstallDirContents() {
        if (!fs.existsSync(this.egeInstallerDir)) {
            return;
        }

        if (fs.existsSync(this.egeIncludeDir) && fs.existsSync(this.egeLibsDir)) {
            const includeFiles = fs.readdirSync(this.egeIncludeDir);
            const libsFiles = fs.readdirSync(this.egeLibsDir);
            if (includeFiles.length != 0 && libsFiles.length != 0) {
                /// no inner paths.
                console.log("Skip path fix...");
                return;
            }
        }

        fs.removeSync(this.egeIncludeDir);
        fs.removeSync(this.egeLibsDir);
        fs.removeSync(this.egeDemoDir);

        const installDirContents = fs.readdirSync(this.egeInstallerDir);
        if (installDirContents.length === 0) {
            vscode.window.showErrorMessage("EGE: No content in the installation dir at: " + this.egeInstallerDir);
            return;
        }

        let validInnerDir: string | undefined;

        /// find install dir.
        installDirContents.forEach(file => {
            console.log("EGE: enum install dir content - " + file);
            const newInstallDir = path.join(this.egeInstallerDir, file);
            const newIncludeDir = path.join(newInstallDir, 'include');
            const newlibsDir = path.join(newInstallDir, 'lib');
            if (fs.existsSync(newIncludeDir) && fs.existsSync(newlibsDir)) {
                if (!validInnerDir) { // pick first
                    validInnerDir = newInstallDir;
                } else {
                    vscode.window.showErrorMessage("EGE: Multi installation dir found, pick the first: " + validInnerDir);
                }
            }
        });

        if (validInnerDir) {
            const installInnerContents = fs.readdirSync(validInnerDir);

            installInnerContents.forEach(file => { /// perform moving...
                const newPath = path.join(this.egeInstallerDir, file);
                if (!fs.existsSync(newPath)) {
                    let srcPath = path.join(validInnerDir as string, file);

                    if (file === 'demo') { /// fix demo dir
                        const newDemoPath = path.join(srcPath, 'src');
                        if (fs.existsSync(newDemoPath)) {
                            srcPath = newDemoPath;
                        }
                    }

                    fs.moveSync(srcPath, newPath);
                }
            });

            fs.removeSync(validInnerDir);
        }
    }

    async performUnzip(): Promise<boolean> {
        this.cleanupInstallDir();
        fs.mkdirpSync(this.egeInstallerDir);

        const files = await decompress(this.egeDownloadedZipFile as string, this.egeInstallerDir as string);

        let errMsg = undefined;

        if (files && files.length > 0) {
            this.fixInstallDirContents();
            return true;
        } else {
            errMsg = "Error unzipping";
            return false;
        }
    }

    async getLatestVersion(): Promise<string | undefined> {
        /// Never return null when request string content.
        const str = await this.requestUrlData(this.egeDownloadUrl + "?getVersion");
        if (str.content) {
            return str.content;
        }
    }

    clearPluginCache() {
        /// remove caches.
        if (this.egeTempDir && this.egeTempDir.length !== 0 && fs.pathExistsSync(this.egeTempDir)) {
            fs.removeSync(this.egeTempDir);
            vscode.window.showInformationMessage("EGE: Cleanup ege plugin cache - Done!");
        }

        if (this.progressHandle) {
            this.progressHandle.cancel();
            delete this.progressHandle;
        }
    }

    /**
     * @param redirectCount hidden argument for url redirect.
     * @returns {Promise | null} Promise to download or null if 'fileToSave' is not null but cannot be written to.
     */
    requestUrlData(url: string, fileToSave?: string, redirectCount?: number): Promise<RequestUrlDataResult> {

        if (redirectCount === undefined) {
            redirectCount = 0;
        }

        let stopReason: string | undefined;

        if (redirectCount === 0) {
            /// Only validate file in first request.
            if (fileToSave && fileToSave.length != 0 && fs.existsSync(fileToSave)) {
                /// File must be writable if exists.
                try {
                    fs.accessSync(fileToSave, fs.constants.W_OK)
                } catch (e) {
                    console.error(e);
                    stopReason = `EGE: File ${fileToSave} already exists and cannot be overwrite! ${e}`;
                }
            }
        } else if (redirectCount > 5) {
            stopReason = "Too many redirects!";
        }

        return new Promise<RequestUrlDataResult>((resolve) => {
            if (stopReason) {
                ege.showErrorBox(stopReason);
                resolve({ error: stopReason });
                return;
            }

            const request = https.get(url, (response) => {
                if (response.statusCode === 302 || response.statusCode === 301) {
                    let redirectLocation = response.headers.location as string;
                    if (redirectLocation.indexOf('://') < 0) {
                        redirectLocation = path.join(url, redirectLocation);
                    }
                    const p = this.requestUrlData(redirectLocation, fileToSave, (redirectCount as number) + 1);
                    p.then(resolve);
                } else if (response.statusCode === 200) {
                    if (fileToSave) {
                        const writeStream = fs.createWriteStream(fileToSave);
                        response.pipe(writeStream, { end: true });
                        response.on('end', () => {
                            writeStream.end();
                            console.log(`Downloading ${url} OK, file: ${fileToSave}`);
                            resolve({});
                        });
                    } else {
                        let strContent = "";
                        response.on('data', data => {
                            strContent += data;
                        });

                        response.on('end', () => {
                            console.log(`Request url ${url} OK, content: ${strContent}`);
                            resolve({ content: strContent });
                        });
                    }
                } else {
                    /// Unexpected err.
                    resolve({ error: `Server respond with ${response.statusCode} - ${response.statusMessage}` });
                }
            });
            request.on('error', (err) => {
                resolve({ error: `ege error: ${err}` });
            });
        });
    }

    cleanup() {
        if (this.progressHandle) {
            this.progressHandle.cancel();
            delete this.progressHandle;
        }
    }

    //////// static scope //////////

    static egeInstance?: EGEInstaller;
    static egeExtensionContext?: vscode.ExtensionContext;

    static registerContext(context: vscode.ExtensionContext) {
        EGEInstaller.egeExtensionContext = context;
        if (!EGEInstaller.egeInstance) {
            EGEInstaller.egeInstance = new EGEInstaller(context);
        }
    }

    static unregister() {
        EGEInstaller.egeInstance?.cleanup();
        delete EGEInstaller.egeInstance;
        delete EGEInstaller.egeExtensionContext;
    }

    static instance(): EGEInstaller {
        return EGEInstaller.egeInstance as EGEInstaller;
    }

    static Compilers = compilers.Compilers;
    static CompilerItem = compilers.CompilerItem;
}

export namespace EGEInstaller {
    export type Compilers = compilers.Compilers;
    export type CompilerItem = compilers.CompilerItem;
}