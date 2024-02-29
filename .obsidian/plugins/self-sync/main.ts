import { App, Editor, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting, TAbstractFile, TFile, TFolder } from 'obsidian';
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
  oldFilePaths: string[] = [];
  syncFilename: string = '.sync';
  apiKey: string = 'XYZ-123-ABC-456-DEF-789';
  url: string = 'http://sync.regevson.com/api/sync';
  vaultName: string = '';

  async onload() {
    await this.loadSettings();

    this.statusBarItemEl = this.addStatusBarItem();

    while (this.app.vault.getFiles().length === 0) {
      console.log("waiting for vault to load");
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    this.vaultName = this.app.vault.getName();

    // const oldTimestampFile = this.app.vault.getFileByPath(this.syncFilename)!;
    // this.oldUpdateTimestamp = Number(await this.app.vault.read(oldTimestampFile)!)
    // this.oldFilePaths = fileContent.split(',');

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
      // console.log('click', evt);
    });

    this.registerInterval(window.setInterval(() => console.log('setInterval'), 5 * 60 * 1000));


  this.registerEvent(this.app.vault.on('modify', (file) => {
    console.log(`File modified: ${file.name}`);
  }));

  this.registerEvent(this.app.vault.on('rename', (file) => {
    console.log('File renamed:', file);
    // console.log(`File renamed: ${file.name}`);
  }));

  }

  async initSync(): Promise<void> {
    this.statusBarItemEl.setText('Syncing...');

    const [addedOrChangedFiles, deletedFilePaths] = await this.identifyModifiedFiles();

    const lastUploadTimestamp = await this.sendFiles(addedOrChangedFiles, deletedFilePaths);
    this.statusBarItemEl.setText('Up To Date');
  }

  async identifyModifiedFiles(): Promise<[TFile[], string[]]> {
    const currentFiles = this.app.vault.getFiles();
    const currentFilePaths = currentFiles.map(f => f.path)

    // when moving or renaming files, the modification date of the file is not updated
    // therefore the file would not be sent to the server and therefore we have to add those files manually
    console.log('old vs  new', this.oldFilePaths, currentFilePaths)
    const deletedFilePaths: string[] = this.oldFilePaths.filter(f => !currentFilePaths.includes(f));
    const newFilePaths: string[] = currentFilePaths.filter(f => !this.oldFilePaths.includes(f));
    const modifiedFilePaths: string[] = currentFiles.filter(f => this.shouldSendFile(f))
                                                    .map(f => f.path);
    const addedOrChangedFilePaths: string[] = Array.from(new Set([...new Set(newFilePaths), ...new Set(modifiedFilePaths)]));
    console.log('newFilePaths', newFilePaths)
    console.log('modifiedFilePaths', modifiedFilePaths)

    const addedOrChangedFiles = addedOrChangedFilePaths
      .map(f => this.app.vault.getAbstractFileByPath(f.trim()))
      .filter((file): file is TFile => file instanceof TFile); // just to ensure not null and correct type

    return [addedOrChangedFiles, deletedFilePaths];
  }

  fileModifiedRecently(file: any): boolean {
    return file.stat.mtime > (this.oldUpdateTimestamp * 1000);
  }

  isValidFileType(filePath: string): boolean {
    return filePath.endsWith('.md') || filePath.endsWith('.jpg') || filePath.endsWith('.png') || filePath.endsWith('.pdf');
  }

  shouldSendFile(file: any): boolean {
    return this.isValidFileType(file.path) && this.fileModifiedRecently(file);
  }

  async sendFiles(addedOrChangedFiles: TFile[], deletedFilePaths: string[]): Promise<void> {
    console.log('starting sync...')
    const headers = {
      'Authorization': `Bearer ${this.apiKey}`
    };

    const formData = await this.packFormData(addedOrChangedFiles, deletedFilePaths);

    try {
      const response = await fetch(this.url, {
        method: 'POST',
        headers: headers,
        body: formData
      });

      if (!response.ok)
        throw new Error(`HTTP error! status: ${response.status}`);

      await this.processResponse(response);
      await this.deleteEmptyFolders();

      console.log('updating')
      this.oldFilePaths = this.app.vault.getFiles().map(f => f.path);
      this.oldUpdateTimestamp = Date.now() / 1000;

    } catch (error) {
      console.error('Error making API call:', error);
    }
    console.log('ending sync...')
  }

  async packFormData(addedOrChangedFiles: TFile[], deletedFilePaths: string[]): Promise<FormData> {
    const formData = new FormData();

    const currentFiles = this.app.vault.getFiles();
    const currentFilePaths = currentFiles.map(f => f.path)
    currentFilePaths.forEach(p => {
      formData.append('all_client_paths', p);
    });

    for(const file of addedOrChangedFiles) {
      let fileContent = null;
      if(!file.path.endsWith('.md'))
        fileContent = await this.app.vault.readBinary(file);
      else
        fileContent = await this.app.vault.cachedRead(file);
      const blob = new Blob([fileContent], { type: 'application/octet-stream' });
      formData.append('modified_and_new_client_files', blob, file.path);
    }
    if (addedOrChangedFiles.length === 0)
      formData.append('modified_and_new_client_files', new Blob(), 'empty');

    deletedFilePaths.forEach(f => {
      formData.append('deleted_client_paths', f);
    });


    formData.append('last_sync_timestamp', this.oldUpdateTimestamp.toString());

    console.log('modified_and_new_client_files', addedOrChangedFiles.map(f => f.path));
    console.log('deleted_client_paths', deletedFilePaths);
    console.log('all_client_paths', currentFilePaths);

    return formData;
  }

async processResponse(response: Response): Promise<void> {
    const zipBlob = await response.blob();
    const zipFile = await JSZip.loadAsync(zipBlob);
    const saveOperations: Promise<void>[] = []; // Array to hold all save operation promises

    zipFile.forEach((relativePath, zipEntry) => {
        console.log('extracting file:', zipEntry.name, relativePath);
        // Instead of awaiting, push the save operation promise into the array
        const saveOperation = this.createDirectoriesIfNeeded(relativePath).then(() => {
            return zipEntry.async('blob').then(blob => {
                const file = new File([blob], zipEntry.name);
                return this.saveFile(file, relativePath); // This promise is returned
            });
        });
        saveOperations.push(saveOperation);
    });

    // Wait for all save operations to complete
    await Promise.all(saveOperations);
    console.log('after saving'); // This now correctly waits for all file saves

    // Proceed with deletion after all files have been saved
    const deletedFilePathsCombined = response.headers.get("Deleted-Files");
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
    console.log('saving file:', targetFilePath);
    const arrayBuffer = await blob.arrayBuffer();
    targetFilePath = targetFilePath.replace(this.vaultName + '/', '');
    await this.app.vault.adapter.writeBinary(targetFilePath, new Uint8Array(arrayBuffer)); // only takes the relative path of the dir the file is in
  }

  async deleteFiles(filePaths: string[]): Promise<void> {
    console.log('deleting files:', filePaths);
    for(const filePath of filePaths) {
      const file = this.app.vault.getAbstractFileByPath(filePath.trim()); // get file from path
      if(file)
        await this.app.vault.trash(file, true);
      else
        console.error(`File not found: ${filePath}`);
    }

  }

  async deleteEmptyFolders() {
    const filesAndFolders: TAbstractFile[] = this.app.vault.getAllLoadedFiles();
    const folders = filesAndFolders.filter(this.isFolder);
    console.log('folders', folders)
    for(const folder of folders) {
      if(folder.children.length === 0) {
        console.log('deleting folder:', folder);
        await this.app.vault.trash(folder, true);
      }
    }
  }

  isFolder(file: TAbstractFile): file is TFolder {
    return 'children' in file;
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
