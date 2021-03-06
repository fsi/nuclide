/**
 * Copyright (c) 2017-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @flow
 * @format
 */

import createPackage from 'nuclide-commons-atom/createPackage';
import CodeHighlightManager from './CodeHighlightManager';

export type CodeHighlightProvider = {
  highlight(
    editor: atom$TextEditor,
    bufferPosition: atom$Point,
  ): Promise<?Array<atom$Range>>,
  priority: number,
  grammarScopes: Array<string>,
};

class Activation {
  _codeHighlightManager: CodeHighlightManager;

  constructor() {
    this._codeHighlightManager = new CodeHighlightManager();
  }

  dispose() {
    this._codeHighlightManager.dispose();
  }

  addProvider(provider: CodeHighlightProvider): IDisposable {
    return this._codeHighlightManager.addProvider(provider);
  }
}

createPackage(module.exports, Activation);
