import { App, Editor, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile } from 'obsidian';
import * as fs from 'fs';
import JSZip from 'jszip';

// Remember to rename these classes and interfaces!

interface MyPluginSettings {
  mySetting: string;
}

const DEFAULT_SETTINGS: MyPluginSettings = {
  mySetting: 'default'
}

export default class SelfSyncPlugin extends Plugin {
  settings: MyPluginSettings;
  statusBarItemEl: HTMLElement;
  oldUpdateTimestamp: number = Date.now() / 1000;
  allFilePaths: string[] = [];
  apiKey: string = 'XYZ-123-ABC-456-DEF-789';
  url: string = 'http://sync.regevson.com/api/sync';
  vaultName: string = 'testing'; // TODO: get from settings

  async onload() {
    await this.loadSettings();

    this.statusBarItemEl = this.addStatusBarItem();

    while (this.app.vault.getFiles().length === 0) {
      console.log("waiting for vault to load");
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    this.allFilePaths = this.app.vault.getFiles().map(f => f.path);

    this.addRibbonIcon('dice', 'Greet', async () => {
      const { spawn } = require('child_process');

      await this.initSync()
      //const intervalId = setInterval(async () => {await this.initSync(directoryPath, vaultName, apiKey, url, this.oldUpdateTimestamp)}, 5000);
    });

    this.addCommand({
      id: 'Sync',
      name: 'Sync Files with Server',
      callback: async () => {
        await this.initSync()
      }
    });

    this.registerDomEvent(document, 'click', (evt: MouseEvent) => {
      console.log('click', evt);
    });

    this.registerInterval(window.setInterval(() => console.log('setInterval'), 5 * 60 * 1000));
  }

  async initSync(): Promise<void> {
    this.statusBarItemEl.setText('Syncing...');

    const filesToSend = await this.iterateAndIdentifyFiles();

    const headers = {
      'Authorization': `Bearer ${this.apiKey}`
    };
    const lastUploadTimestamp = await this.sendFiles(filesToSend);
    this.statusBarItemEl.setText('Up To Date');
  }

  async iterateAndIdentifyFiles(): Promise<Array<any>> {
    const allFiles = this.app.vault.getFiles();

    const allFilePaths = allFiles.map(f => f.path)
    // when moving or renaming files, the modification date of the file is not updated
    // therefore the file would not be sent to the server and therefore we have to add those files manually
    const modifiedUntrackedFilePaths = allFilePaths.filter(path => !this.allFilePaths.includes(path));
    const modifiedUntrackedFiles = modifiedUntrackedFilePaths
      .map(f => this.app.vault.getAbstractFileByPath(f.trim()))
      .filter((file): file is TFile => file instanceof TFile); // just to ensure not null and correct type

    let modifiedFiles = allFiles.filter(f => this.shouldSendFile(f));
    modifiedFiles.push(...modifiedUntrackedFiles);
    modifiedFiles = Array.from(new Set(modifiedFiles)); // remove duplicates -> newly created files are in @modifiedUntrackedFiles and in @modifiedFiles
    return modifiedFiles;
  }

  fileModifiedRecently(mtime: number): boolean {
    return mtime > this.oldUpdateTimestamp * 1000;
  }

  isValidFileType(filePath: string): boolean {
    return filePath.endsWith('.md') || filePath.endsWith('.jpg') || filePath.endsWith('.png') || filePath.endsWith('.pdf');
  }

  shouldSendFile(file: any): boolean {
    return this.isValidFileType(file.path) && this.fileModifiedRecently(file.stat.mtime);
  }

  async sendFiles(filesToSend: Array<any>): Promise<void> {
    const headers = {
      'Authorization': `Bearer ${this.apiKey}`
    };

    const formData = await this.packFormData(filesToSend);

    try {
      const response = await fetch(this.url, {
        method: 'POST',
        headers: headers,
        body: formData
      });

      if (!response.ok)
        throw new Error(`HTTP error! status: ${response.status}`);

      await this.processResponse(response);

      this.oldUpdateTimestamp = Date.now() / 1000;
      this.allFilePaths = this.app.vault.getFiles().map(f => f.path);

    } catch (error) {
      console.error('Error making API call:', error);
    }
  }

  async packFormData(filesToSend: Array<any>): Promise<FormData> {
    const formData = new FormData();
    for(const file of filesToSend) {
      let fileContent = null;
      if(!file.path.endsWith('.md'))
        fileContent = await this.app.vault.readBinary(file);
      else
        fileContent = await this.app.vault.cachedRead(file);
      const blob = new Blob([fileContent], { type: 'application/octet-stream' });
      formData.append('modified_client_files', blob, file.path);
    }
    if (filesToSend.length === 0)
      formData.append('modified_client_files', new Blob(), 'empty');

    // also send to the server an index of all file-paths in vault (server uses this for analysis)
    let allFiles = this.app.vault.getFiles();
    allFiles.forEach(f => {
      formData.append('all_client_file_paths', f.path);
    });

    formData.append('last_sync_timestamp', this.oldUpdateTimestamp.toString());

    return formData;
  }

  async processResponse(response: Response): Promise<void> {
    const zipBlob = await response.blob();
    const zipFile = await JSZip.loadAsync(zipBlob);
    zipFile.forEach(async (relativePath, zipEntry) => {
      await this.createDirectoriesIfNeeded(relativePath);

      // extract the file
      zipEntry.async('blob').then(blob => {
        const file = new File([blob], zipEntry.name);
        this.saveFile(file, relativePath);
      });
    });

    const deletedFilePathsCombined = response.headers.get("Deleted-Files"); // files that were deleted on the server (returned as ',' separated string of file-paths)
    const deletedFilePaths = deletedFilePathsCombined ? deletedFilePathsCombined.split(',') : [];
    await this.deleteFiles(deletedFilePaths);
  }

  async createDirectoriesIfNeeded(filePath: string): Promise<void> {
    try {
      const relFilePath = filePath.replace(this.vaultName + '/', '');
      const lastSlashIndex = relFilePath.lastIndexOf('/');
      const relFileDirectory = relFilePath.substring(0, lastSlashIndex);
      await this.app.vault.createFolder(relFileDirectory); // only takes the relative path of the dir the file is in
    } catch (error) {
      console.error(`Error creating directories: ${error}`);
    }
  }

  async saveFile(blob: any, targetFilePath: any) {
    const arrayBuffer = await blob.arrayBuffer();
    targetFilePath = targetFilePath.replace(this.vaultName + '/', '');
    await this.app.vault.adapter.writeBinary(targetFilePath, new Uint8Array(arrayBuffer)); // only takes the relative path of the dir the file is in
  }

  async deleteFiles(filePaths: string[]): Promise<void> {
    for(const filePath of filePaths) {
      const file = this.app.vault.getAbstractFileByPath(filePath.trim()); // get file from path
      if(file)
        await this.app.vault.trash(file, true);
      else
        console.error(`File not found: ${filePath}`);
    }

  }


  onunload() {

  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

class SampleModal extends Modal {
  constructor(app: App) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.setText('Woah!');
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}

//class SampleSettingTab extends PluginSettingTab {
//plugin: MyPlugin;

//constructor(app: App, plugin: MyPlugin) {
//super(app, plugin);
//this.plugin = plugin;
//}

//display(): void {
//const {containerEl} = this;

//containerEl.empty();

//new Setting(containerEl)
//.setName('Setting #1')
//.setDesc('It\'s a secret')
//.addText(text => text
//.setPlaceholder('Enter your secret')
//.setValue(this.plugin.settings.mySetting)
//.onChange(async (value) => {
//this.plugin.settings.mySetting = value;
//await this.plugin.saveSettings();
//}));
//}
//}
