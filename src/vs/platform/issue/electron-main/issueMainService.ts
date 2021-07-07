/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from 'vs/nls';
import { arch, release, type } from 'os';
import product from 'vs/platform/product/common/product';
import { ICommonIssueService, IssueReporterWindowConfiguration, IssueReporterData, ProcessExplorerData, ProcessExplorerWindowConfiguration } from 'vs/platform/issue/common/issue';
import { BrowserWindow, ipcMain, screen, IpcMainEvent, Display } from 'electron';
import { ILaunchMainService } from 'vs/platform/launch/electron-main/launchMainService';
import { IDiagnosticsService, PerformanceInfo, isRemoteDiagnosticError } from 'vs/platform/diagnostics/common/diagnostics';
import { IEnvironmentMainService } from 'vs/platform/environment/electron-main/environmentMainService';
import { isMacintosh, IProcessEnvironment, browserCodeLoadingCacheStrategy } from 'vs/base/common/platform';
import { ILogService } from 'vs/platform/log/common/log';
import { IWindowState } from 'vs/platform/windows/electron-main/windows';
import { listProcesses } from 'vs/base/node/ps';
import { IDialogMainService } from 'vs/platform/dialogs/electron-main/dialogMainService';
import { createDecorator } from 'vs/platform/instantiation/common/instantiation';
import { zoomLevelToZoomFactor } from 'vs/platform/windows/common/windows';
import { FileAccess } from 'vs/base/common/network';
import { INativeHostMainService } from 'vs/platform/native/electron-main/nativeHostMainService';
import { IIPCObjectUrl, IProtocolMainService } from 'vs/platform/protocol/electron-main/protocol';
import { DisposableStore } from 'vs/base/common/lifecycle';

export const IIssueMainService = createDecorator<IIssueMainService>('issueMainService');

export interface IIssueMainService extends ICommonIssueService { }

export class IssueMainService implements ICommonIssueService {

	declare readonly _serviceBrand: undefined;

	private static readonly DEFAULT_BACKGROUND_COLOR = '#1E1E1E';

	private issueReporterWindow: BrowserWindow | null = null;
	private issueReporterParentWindow: BrowserWindow | null = null;

	private processExplorerWindow: BrowserWindow | null = null;
	private processExplorerParentWindow: BrowserWindow | null = null;

	private _browserWindow: BrowserWindow | null = null;
	private _browserParentWindow: BrowserWindow | null = null;

	constructor(
		private userEnv: IProcessEnvironment,
		@IEnvironmentMainService private readonly environmentMainService: IEnvironmentMainService,
		@ILaunchMainService private readonly launchMainService: ILaunchMainService,
		@ILogService private readonly logService: ILogService,
		@IDiagnosticsService private readonly diagnosticsService: IDiagnosticsService,
		@IDialogMainService private readonly dialogMainService: IDialogMainService,
		@INativeHostMainService private readonly nativeHostMainService: INativeHostMainService,
		@IProtocolMainService private readonly protocolMainService: IProtocolMainService
	) {
		this.registerListeners();
	}

	private registerListeners(): void {
		ipcMain.on('vscode:issueSystemInfoRequest', async event => {
			const [info, remoteData] = await Promise.all([this.launchMainService.getMainProcessInfo(), this.launchMainService.getRemoteDiagnostics({ includeProcesses: false, includeWorkspaceMetadata: false })]);
			const msg = await this.diagnosticsService.getSystemInfo(info, remoteData);

			this.safeSend(event, 'vscode:issueSystemInfoResponse', msg);
		});

		ipcMain.on('vscode:listProcesses', async event => {
			const processes = [];

			try {
				const mainPid = await this.launchMainService.getMainProcessId();
				processes.push({ name: localize('local', "Local"), rootProcess: await listProcesses(mainPid) });

				const remoteDiagnostics = await this.launchMainService.getRemoteDiagnostics({ includeProcesses: true });
				remoteDiagnostics.forEach(data => {
					if (isRemoteDiagnosticError(data)) {
						processes.push({
							name: data.hostName,
							rootProcess: data
						});
					} else {
						if (data.processes) {
							processes.push({
								name: data.hostName,
								rootProcess: data.processes
							});
						}
					}
				});
			} catch (e) {
				this.logService.error(`Listing processes failed: ${e}`);
			}

			this.safeSend(event, 'vscode:listProcessesResponse', processes);
		});

		ipcMain.on('vscode:issueReporterClipboard', async event => {
			const messageOptions = {
				message: localize('issueReporterWriteToClipboard', "There is too much data to send to GitHub directly. The data will be copied to the clipboard, please paste it into the GitHub issue page that is opened."),
				type: 'warning',
				buttons: [
					localize('ok', "OK"),
					localize('cancel', "Cancel")
				]
			};

			if (this.issueReporterWindow) {
				const result = await this.dialogMainService.showMessageBox(messageOptions, this.issueReporterWindow);
				this.safeSend(event, 'vscode:issueReporterClipboardResponse', result.response === 0);
			}
		});

		ipcMain.on('vscode:issuePerformanceInfoRequest', async event => {
			const performanceInfo = await this.getPerformanceInfo();
			this.safeSend(event, 'vscode:issuePerformanceInfoResponse', performanceInfo);
		});

		ipcMain.on('vscode:issueReporterConfirmClose', async () => {
			const messageOptions = {
				message: localize('confirmCloseIssueReporter', "Your input will not be saved. Are you sure you want to close this window?"),
				type: 'warning',
				buttons: [
					localize('yes', "Yes"),
					localize('cancel', "Cancel")
				]
			};

			if (this.issueReporterWindow) {
				const result = await this.dialogMainService.showMessageBox(messageOptions, this.issueReporterWindow);
				if (result.response === 0) {
					if (this.issueReporterWindow) {
						this.issueReporterWindow.destroy();
						this.issueReporterWindow = null;
					}
				}
			}
		});

		ipcMain.on('vscode:workbenchCommand', (_: unknown, commandInfo: { id: any; from: any; args: any; }) => {
			const { id, from, args } = commandInfo;

			let parentWindow: BrowserWindow | null;
			switch (from) {
				case 'issueReporter':
					parentWindow = this.issueReporterParentWindow;
					break;
				case 'processExplorer':
					parentWindow = this.processExplorerParentWindow;
					break;
				default:
					throw new Error(`Unexpected command source: ${from}`);
			}

			if (parentWindow) {
				parentWindow.webContents.send('vscode:runAction', { id, from, args });
			}
		});

		ipcMain.on('vscode:openExternal', (_: unknown, arg: string) => {
			this.nativeHostMainService.openExternal(undefined, arg);
		});

		ipcMain.on('vscode:closeIssueReporter', event => {
			if (this.issueReporterWindow) {
				this.issueReporterWindow.close();
			}
		});

		ipcMain.on('vscode:closeProcessExplorer', event => {
			if (this.processExplorerWindow) {
				this.processExplorerWindow.close();
			}
		});

		ipcMain.on('vscode:windowsInfoRequest', async event => {
			const mainProcessInfo = await this.launchMainService.getMainProcessInfo();
			this.safeSend(event, 'vscode:windowsInfoResponse', mainProcessInfo.windows);
		});

		ipcMain.on('vscode:closeBrowserWindow', (event: IpcMainEvent) => {
			if (this._browserWindow) {
				this._browserWindow.close();
			}
		});
	}

	private safeSend(event: IpcMainEvent, channel: string, ...args: unknown[]): void {
		if (!event.sender.isDestroyed()) {
			event.sender.send(channel, ...args);
		}
	}

	openBrowserWindow(args: any): Promise<void> {
		return new Promise((resolve, reject) => {
			if (this._browserWindow && !this._browserWindow.isDestroyed()) {
				if (this._browserWindow.isMinimized()) {
					this._browserWindow.restore();
				}
				this._browserWindow.focus();
				reject();
				return;
			}
			if (!args || args.length === 0) {
				reject();
				return;
			}
			const config = args[0];
			let windowHeight;
			if (process.platform === 'win32') {
				windowHeight = config['height'] ? config['height'] : 10;
			}
			else {
				windowHeight = config['height'] ? (config['height'] + 15) : 25;
			}
			const windowWidth = config['width'];

			if (!this._browserWindow) {
				this._browserParentWindow = BrowserWindow.getFocusedWindow();
				if (this._browserParentWindow) {
					const position = this.getWindowPosition(this._browserParentWindow, 700, 800);
					this._browserWindow = new BrowserWindow({
						fullscreen: false,
						frame: false,
						transparent: false,
						show: false,
						center: true,
						parent: this._browserParentWindow,
						width: windowWidth ? windowWidth : position.width,
						height: windowHeight ? windowHeight : position.height,
						minWidth: 300,
						minHeight: 200,
						title: localize('openBrowserWindow', "open BrowserWindow"),
						backgroundColor: (config['data'].theme.indexOf('Dark') !== -1) ? config['darkBackgroundColor'] : config['lightBackgroundColor'],
						webPreferences: {
							nodeIntegration: true,
							contextIsolation: false,
							//enableRemoteModule: true
						}
					});
					this._browserWindow.setMenuBarVisibility(false);
					this._browserWindow.webContents.openDevTools();
					this.logService.trace('issueService#openBrowserWindow: opening BrowserWindow');
					this._browserWindow.loadURL(config['loadURL']);
					this._browserWindow.once('ready-to-show', () => {
						this._browserWindow?.show();
						this._browserWindow?.setAlwaysOnTop(true);
						setTimeout(() => {
							this._browserWindow?.setAlwaysOnTop(false);
							if (config['winId'] === 'addEmulator') {
								resolve();
							}
						}, 100);
					});
					if (config['data']) {
						this._browserWindow.webContents.on('did-finish-load', () => {
							this._browserWindow?.webContents.send('stored-data', config['data']);
						});
					}
					const from = 'mouse';
					if (config['events'] && config['events'].length > 0) {
						for (let i = 0; i < config['events'].length; ++i) {
							let event = config['events'][i];
							let channel = event['channel'];
							let command = event['command'];
							if (!event || !channel || !command) {
								continue;
							}
							ipcMain.removeAllListeners(channel);
							ipcMain.on(channel, (event, args) => {

								switch (config['winId']) {
									case 'certificate':
										resolve(args);
										break;
									default:
										this._browserParentWindow?.webContents.send('vscode:runAction', { id: command, from: from, args: [args] });
								}
							});
							this._browserWindow.on('closed', () => {
								ipcMain.removeAllListeners(channel);
								this._browserWindow = null;
								reject();
							});
						}
					}
					else {
						this._browserWindow.on('closed', () => {
							this._browserWindow = null;
							reject();
						});
					}

					this._browserParentWindow.on('closed', () => {
						if (this._browserWindow) {
							this._browserWindow.close();
							this._browserWindow = null;
							reject();
						}
					});
				}
			}

			if (this._browserWindow) {
				this._browserWindow.focus();
			}
		});
	}

	async openReporter(data: IssueReporterData): Promise<void> {
		if (!this.issueReporterWindow) {
			this.issueReporterParentWindow = BrowserWindow.getFocusedWindow();
			if (this.issueReporterParentWindow) {
				const issueReporterDisposables = new DisposableStore();

				const issueReporterWindowConfigUrl = issueReporterDisposables.add(this.protocolMainService.createIPCObjectUrl<IssueReporterWindowConfiguration>());
				const position = this.getWindowPosition(this.issueReporterParentWindow, 700, 800);

				this.issueReporterWindow = this.createBrowserWindow(position, issueReporterWindowConfigUrl, data.styles.backgroundColor, localize('issueReporter', "Issue Reporter"), data.zoomLevel);

				// Store into config object URL
				issueReporterWindowConfigUrl.update({
					appRoot: this.environmentMainService.appRoot,
					windowId: this.issueReporterWindow.id,
					userEnv: this.userEnv,
					data,
					disableExtensions: !!this.environmentMainService.disableExtensions,
					os: {
						type: type(),
						arch: arch(),
						release: release(),
					},
					product
				});

				this.issueReporterWindow.loadURL(
					FileAccess.asBrowserUri('vs/code/electron-sandbox/issue/issueReporter.html', require, true).toString(true)
				);

				this.issueReporterWindow.on('close', () => {
					this.issueReporterWindow = null;

					issueReporterDisposables.dispose();
				});

				this.issueReporterParentWindow.on('closed', () => {
					if (this.issueReporterWindow) {
						this.issueReporterWindow.close();
						this.issueReporterWindow = null;

						issueReporterDisposables.dispose();
					}
				});
			}
		}

		this.issueReporterWindow?.focus();
	}

	async openProcessExplorer(data: ProcessExplorerData): Promise<void> {
		if (!this.processExplorerWindow) {
			this.processExplorerParentWindow = BrowserWindow.getFocusedWindow();
			if (this.processExplorerParentWindow) {
				const processExplorerDisposables = new DisposableStore();

				const processExplorerWindowConfigUrl = processExplorerDisposables.add(this.protocolMainService.createIPCObjectUrl<ProcessExplorerWindowConfiguration>());
				const position = this.getWindowPosition(this.processExplorerParentWindow, 800, 500);

				this.processExplorerWindow = this.createBrowserWindow(position, processExplorerWindowConfigUrl, data.styles.backgroundColor, localize('processExplorer', "Process Explorer"), data.zoomLevel);

				// Store into config object URL
				processExplorerWindowConfigUrl.update({
					appRoot: this.environmentMainService.appRoot,
					windowId: this.processExplorerWindow.id,
					userEnv: this.userEnv,
					data,
					product
				});

				this.processExplorerWindow.loadURL(
					FileAccess.asBrowserUri('vs/code/electron-sandbox/processExplorer/processExplorer.html', require, true).toString(true)
				);

				this.processExplorerWindow.on('close', () => {
					this.processExplorerWindow = null;
					processExplorerDisposables.dispose();
				});

				this.processExplorerParentWindow.on('close', () => {
					if (this.processExplorerWindow) {
						this.processExplorerWindow.close();
						this.processExplorerWindow = null;

						processExplorerDisposables.dispose();
					}
				});
			}
		}

		this.processExplorerWindow?.focus();
	}

	private createBrowserWindow<T>(position: IWindowState, ipcObjectUrl: IIPCObjectUrl<T>, backgroundColor: string | undefined, title: string, zoomLevel: number): BrowserWindow {
		const window = new BrowserWindow({
			fullscreen: false,
			skipTaskbar: true,
			resizable: true,
			width: position.width,
			height: position.height,
			minWidth: 300,
			minHeight: 200,
			x: position.x,
			y: position.y,
			title,
			backgroundColor: backgroundColor || IssueMainService.DEFAULT_BACKGROUND_COLOR,
			webPreferences: {
				preload: FileAccess.asFileUri('vs/base/parts/sandbox/electron-browser/preload.js', require).fsPath,
				additionalArguments: [`--vscode-window-config=${ipcObjectUrl.resource.toString()}`, '--context-isolation' /* TODO@bpasero: Use process.contextIsolateed when 13-x-y is adopted (https://github.com/electron/electron/pull/28030) */],
				v8CacheOptions: browserCodeLoadingCacheStrategy,
				enableWebSQL: false,
				enableRemoteModule: false,
				spellcheck: false,
				nativeWindowOpen: true,
				zoomFactor: zoomLevelToZoomFactor(zoomLevel),
				sandbox: true,
				contextIsolation: true
			}
		});

		window.setMenuBarVisibility(false);

		return window;
	}

	async getSystemStatus(): Promise<string> {
		const [info, remoteData] = await Promise.all([this.launchMainService.getMainProcessInfo(), this.launchMainService.getRemoteDiagnostics({ includeProcesses: false, includeWorkspaceMetadata: false })]);

		return this.diagnosticsService.getDiagnostics(info, remoteData);
	}

	private getWindowPosition(parentWindow: BrowserWindow, defaultWidth: number, defaultHeight: number): IWindowState {

		// We want the new window to open on the same display that the parent is in
		let displayToUse: Display | undefined;
		const displays = screen.getAllDisplays();

		// Single Display
		if (displays.length === 1) {
			displayToUse = displays[0];
		}

		// Multi Display
		else {

			// on mac there is 1 menu per window so we need to use the monitor where the cursor currently is
			if (isMacintosh) {
				const cursorPoint = screen.getCursorScreenPoint();
				displayToUse = screen.getDisplayNearestPoint(cursorPoint);
			}

			// if we have a last active window, use that display for the new window
			if (!displayToUse && parentWindow) {
				displayToUse = screen.getDisplayMatching(parentWindow.getBounds());
			}

			// fallback to primary display or first display
			if (!displayToUse) {
				displayToUse = screen.getPrimaryDisplay() || displays[0];
			}
		}

		const state: IWindowState = {
			width: defaultWidth,
			height: defaultHeight
		};

		const displayBounds = displayToUse.bounds;
		state.x = displayBounds.x + (displayBounds.width / 2) - (state.width! / 2);
		state.y = displayBounds.y + (displayBounds.height / 2) - (state.height! / 2);

		if (displayBounds.width > 0 && displayBounds.height > 0 /* Linux X11 sessions sometimes report wrong display bounds */) {
			if (state.x < displayBounds.x) {
				state.x = displayBounds.x; // prevent window from falling out of the screen to the left
			}

			if (state.y < displayBounds.y) {
				state.y = displayBounds.y; // prevent window from falling out of the screen to the top
			}

			if (state.x > (displayBounds.x + displayBounds.width)) {
				state.x = displayBounds.x; // prevent window from falling out of the screen to the right
			}

			if (state.y > (displayBounds.y + displayBounds.height)) {
				state.y = displayBounds.y; // prevent window from falling out of the screen to the bottom
			}

			if (state.width! > displayBounds.width) {
				state.width = displayBounds.width; // prevent window from exceeding display bounds width
			}

			if (state.height! > displayBounds.height) {
				state.height = displayBounds.height; // prevent window from exceeding display bounds height
			}
		}

		return state;
	}

	private async getPerformanceInfo(): Promise<PerformanceInfo> {
		try {
			const [info, remoteData] = await Promise.all([this.launchMainService.getMainProcessInfo(), this.launchMainService.getRemoteDiagnostics({ includeProcesses: true, includeWorkspaceMetadata: true })]);
			return await this.diagnosticsService.getPerformanceInfo(info, remoteData);
		} catch (error) {
			this.logService.warn('issueService#getPerformanceInfo ', error.message);

			throw error;
		}
	}
}
