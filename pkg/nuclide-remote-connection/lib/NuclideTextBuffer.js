/**
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the license found in the LICENSE file in
 * the root directory of this source tree.
 *
 * @flow
 * @format
 */

import type {ServerConnection} from './ServerConnection';
import type {RemoteFile} from './RemoteFile';

import {getLogger} from 'log4js';
import invariant from 'assert';
import {CompositeDisposable, TextBuffer} from 'atom';
import {track} from '../../nuclide-analytics';
import {RpcTimeoutError} from '../../nuclide-rpc';
import nuclideUri from 'nuclide-commons/nuclideUri';
import {countOccurrences} from 'nuclide-commons/string';
import loadingNotification from '../../commons-atom/loading-notification';

// Diffing is O(lines^2), so don't bother for files with too many lines.
const DIFF_LINE_LIMIT = 10000;

export default class NuclideTextBuffer extends TextBuffer {
  _connection: ServerConnection;
  fileSubscriptions: ?CompositeDisposable;
  /* $FlowFixMe */
  file: ?RemoteFile;
  conflict: boolean;
  _exists: boolean;

  // This is a counter that will be incremented after every successful save request.
  // We use this to accurately detect changes on disk - conflicts should not be reported
  // if any saves finished while fetching the updated contents.
  _saveID: number;
  // Handling pending saves is also tricky. It's possible we get the file change event
  // before the file finishes saving, which is fine.
  _pendingSaveContents: ?string;

  constructor(connection: ServerConnection, params: any) {
    super(params);
    this._exists = true;
    this._connection = connection;
    this._saveID = 0;
    this._pendingSaveContents = null;
    this.setPath(params.filePath);
    const encoding: string = (atom.config.get('core.fileEncoding'): any);
    this.setEncoding(encoding);
  }

  // Atom 1.4.0+ serializes TextBuffers with the ID generated by `getId`. When
  // a buffer is deserialized, it is looked up in the buffer cache by this key.
  // The logic there is setup to create a new buffer when there is a cache miss.
  // However, when there is no key, it's not looked up in cache, but rather by
  // its path. This behavior ensures that when a connection is reestablished,
  // a buffer exists with that path. See https://github.com/atom/atom/pull/9968.
  getId(): string {
    return '';
  }

  setPath(filePath: string): void {
    if (!this._connection) {
      // If this._connection is not set, then the superclass constructor is still executing.
      // NuclideTextBuffer's constructor will ensure setPath() is called once this.constructor
      // is set.
      return;
    }
    if (filePath === this.getPath()) {
      return;
    }
    if (filePath) {
      if (this.file != null) {
        this.file.setPath(this._connection.getUriOfRemotePath(filePath));
      } else {
        this.file = this.createFile(filePath);
        if (this.file !== null) {
          const file = this.file;
          file.setEncoding(this.getEncoding());
          this.subscribeToFile();
        }
      }
    } else {
      this.file = null;
    }
    this.emitter.emit('did-change-path', this.getPath());
  }

  createFile(filePath: string): RemoteFile {
    return this._connection.createFile(filePath);
  }

  async saveAs(filePath: string): Promise<void> {
    if (!filePath) {
      throw new Error("Can't save buffer with no file path");
    }

    let success;
    this.emitter.emit('will-save', {path: filePath});
    this.setPath(filePath);
    const toSaveContents = this.getText();
    try {
      const file = this.file;
      invariant(file, 'Cannot save an null file!');
      this._pendingSaveContents = toSaveContents;
      await loadingNotification(
        file.write(toSaveContents),
        `Saving ${nuclideUri.nuclideUriToDisplayString(filePath)}...`,
        1000 /* delay */,
      );
      this.cachedDiskContents = toSaveContents;
      this._saveID++;
      this.conflict = false;
      this.emitModifiedStatusChanged(false);
      this.emitter.emit('did-save', {path: filePath});
      success = true;
    } catch (e) {
      // Timeouts occur quite frequently when the network is unstable.
      // Demote these to 'error' level.
      const logger = getLogger('nuclide-remote-connection');
      const logFunction = e instanceof RpcTimeoutError
        ? logger.error
        : logger.fatal;
      logFunction('Failed to save remote file.', e);
      let message = e.message;
      // This can happen if the user triggered the save while closing the file.
      // Unfortunately, we can't interrupt the user action, but we can at least reopen the buffer.
      if (this.destroyed) {
        message += '<br><br>Opening a new tab with your unsaved changes.';
        // goToLocation does not support opening an untitled editor
        // eslint-disable-next-line nuclide-internal/atom-apis
        atom.workspace.open().then(editor => editor.setText(toSaveContents));
      }
      atom.notifications.addError(
        `Failed to save remote file ${filePath}: ${message}`,
      );
      success = false;
    }

    // Once the save is finished, cachedDiskContents is the source of truth.
    this._pendingSaveContents = null;

    track('remoteprojects-text-buffer-save-as', {
      'remoteprojects-file-path': filePath,
      'remoteprojects-save-success': success.toString(),
    });
  }

  updateCachedDiskContentsSync(): void {
    throw new Error(
      "updateCachedDiskContentsSync isn't supported in NuclideTextBuffer",
    );
  }

  async updateCachedDiskContents(
    flushCache?: boolean,
    callback?: () => mixed,
  ): Promise<void> {
    try {
      // Babel workaround: w/o the es2015-classes transform, async functions can't call `super`.
      // https://github.com/babel/babel/issues/3930
      await TextBuffer.prototype.updateCachedDiskContents.call(
        this,
        flushCache,
        callback,
      );
      this._exists = true;
    } catch (e) {
      this._exists = false;
      throw e;
    }
  }

  // Override of TextBuffer's implementation.
  // Atom tries to diff contents even for extremely large files, which can
  // easily cause the editor to lock.
  // TODO(hansonw): Remove after https://github.com/atom/text-buffer/issues/153 is resolved.
  setTextViaDiff(newText: string): void {
    if (
      this.getLineCount() > DIFF_LINE_LIMIT ||
      countOccurrences(newText, '\n') > DIFF_LINE_LIMIT
    ) {
      this.setText(newText);
    } else {
      super.setTextViaDiff(newText);
    }
  }

  subscribeToFile(): void {
    if (this.fileSubscriptions) {
      this.fileSubscriptions.dispose();
    }
    const file = this.file;
    invariant(file, 'Cannot subscribe to no-file');
    const fileSubscriptions = new CompositeDisposable();

    fileSubscriptions.add(
      file.onDidChange(async () => {
        const isModified = this._isModified();
        this.emitModifiedStatusChanged(isModified);
        if (isModified) {
          this.conflict = true;
        }
        const previousContents = this.cachedDiskContents;
        const previousSaveID = this._saveID;
        await this.updateCachedDiskContents();
        // If any save requests finished in the meantime, previousContents is not longer accurate.
        // The most recent save request should trigger another change event, so we'll check for
        // conflicts when that happens.
        // Also, if a save is currently pending, it's possible we get the change event before the
        // write promise comes back.
        // Otherwise, what we wrote and what we read should match exactly.
        if (
          this._saveID !== previousSaveID ||
          previousContents === this.cachedDiskContents ||
          this._pendingSaveContents === this.cachedDiskContents
        ) {
          this.conflict = false;
          return;
        }
        if (this.conflict) {
          this.emitter.emit('did-conflict');
        } else {
          this.reload();
        }
      }),
    );

    fileSubscriptions.add(
      file.onDidDelete(() => {
        this._exists = false;
        const modified = this.getText() !== this.cachedDiskContents;
        this.wasModifiedBeforeRemove = modified;
        if (modified) {
          this.updateCachedDiskContents();
        } else {
          this._maybeDestroy();
        }
      }),
    );

    // TODO: Not supported by RemoteFile.
    // fileSubscriptions.add(file.onDidRename(() => {
    //   this.emitter.emit('did-change-path', this.getPath());
    // }));

    fileSubscriptions.add(
      file.onWillThrowWatchError(errorObject => {
        this.emitter.emit('will-throw-watch-error', errorObject);
      }),
    );

    this.fileSubscriptions = fileSubscriptions;
  }

  _maybeDestroy(): void {
    if (
      this.shouldDestroyOnFileDelete == null ||
      this.shouldDestroyOnFileDelete()
    ) {
      this.destroy();
    } else {
      if (this.fileSubscriptions != null) {
        // Soft delete the file.
        this.fileSubscriptions.dispose();
      }
      this.conflict = false;
      this.cachedDiskContents = null;
      this.emitModifiedStatusChanged(!this.isEmpty());
    }
  }

  _isModified(): boolean {
    if (!this.loaded) {
      return false;
    }
    if (this.file) {
      if (this._exists) {
        return this.getText() !== this.cachedDiskContents;
      } else {
        return this.wasModifiedBeforeRemove ? !this.isEmpty() : false;
      }
    } else {
      return !this.isEmpty();
    }
  }
}
