// @
// Copyright (c) 2017 Google Inc. All rights reserved.
// This code may only be used under the BSD style license found at
// http://polymer.github.io/LICENSE.txt
// Code distributed by Google as part of this project is also
// subject to an additional IP rights grant found at
// http://polymer.github.io/PATENTS.txt

import StorageProviderBase from './storage-provider-base.js';
import firebase from '../../platform/firebase-web.js';
import assert from '../../platform/assert-web.js';
import KeyBase from './key-base.js';

class FirebaseKey extends KeyBase {
  constructor(key) {
    super();
    var parts = key.split('://');
    this.protocol = parts[0];
    assert(this.protocol == 'firebase');
    if (parts[1]) {
      parts = parts[1].split('/');
      assert(parts[0].endsWith('.firebaseio.com'));
      this.databaseUrl = parts[0];
      this.projectId = this.databaseUrl.split('.')[0];
      this.apiKey = parts[1];
      this.location = parts.slice(2).join('/');
    } else {
      this.databaseUrl = undefined;
      this.projectId = undefined;
      this.apiKey = undefined;
      this.location = '';
    }
  }

  childKeyForHandle(id) {
    let location = '';
    if (this.location != undefined && this.location.length > 0)
      location = this.location + '/';
    location += `handles/${id}`;
    return new FirebaseKey(`${this.protocol}://${this.databaseUrl}/${this.apiKey}/${location}`);
  }

  toString() {
    if (this.databaseUrl && this.apiKey)
      return `${this.protocol}://${this.databaseUrl}/${this.apiKey}/${this.location}`;
    return `${this.protocol}://`;
  }
}

async function realTransaction(reference, transactionFunction) {
  let realData = undefined;
  await reference.once('value', data => {realData = data.val(); });
  return reference.transaction(data => {
    if (data == null)
      data = realData;
    return transactionFunction(data);
  }, undefined, false);
}

let _nextAppNameSuffix = 0;

export default class FirebaseStorage {
  constructor(arc) {
    this._arc = arc;
    this._apps = {};
  }

  async construct(id, type, keyFragment) {
    return this._join(id, type, keyFragment, false);
  }

  async connect(id, type, key) {
    return this._join(id, type, key, true);
  }

  parseStringAsKey(string) {
    return new FirebaseKey(string);
  }

  async _join(id, type, key, shouldExist) {
    key = new FirebaseKey(key);
    // TODO: is it ever going to be possible to autoconstruct new firebase datastores?
    if (key.databaseUrl == undefined || key.apiKey == undefined)
      throw new Error('Can\'t complete partial firebase keys');

    if (this._apps[key.projectId] == undefined) {
      for (var app of firebase.apps) {
        if (app.options.databaseURL == key.databaseURL) {
          this._apps[key.projectId] = app;
          break;
        }
      }
    }

    if (this._apps[key.projectId] == undefined) {
      this._apps[key.projectId] = firebase.initializeApp({
        apiKey: key.apiKey,
        databaseURL: key.databaseUrl
      }, `app${_nextAppNameSuffix++}`);
    }

    var reference = firebase.database(this._apps[key.projectId]).ref(key.location);

    let result = await realTransaction(reference, data => {
      if ((data == null) == shouldExist)
        return; // abort transaction
      if (!shouldExist) {
        return {version: 0};
      }
      return data;
    });


    if (!result.committed)
      return null;

    return FirebaseStorageProvider.newProvider(type, this._arc, id, reference, key);
  }
}

class FirebaseStorageProvider extends StorageProviderBase {
  constructor(type, arc, id, reference, key) {
    super(type, arc, undefined, id, key.toString());
    this.firebaseKey = key;
    this.reference = reference;
  }

  static newProvider(type, arc, id, reference, key) {
    if (type.isSetView)
      return new FirebaseCollection(type, arc, id, reference, key);
    return new FirebaseVariable(type, arc, id, reference, key);
  }

  static encodeKey(key) {
    key = btoa(key);
    return key.replace(/\//g, '*');
  }
  static decodeKey(key) {
    key = key.replace(/\*/g, '/');
    return atob(key);
  }
}

class FirebaseVariable extends FirebaseStorageProvider {
  constructor(type, arc, id, reference, firebaseKey) {
    super(type, arc, id, reference, firebaseKey);
    this.dataSnapshot = undefined;
    this._pendingGets = [];
    this.reference.on('value', dataSnapshot => {
      this.dataSnapshot = dataSnapshot;
      let data = dataSnapshot.val();
      this._pendingGets.forEach(_get => _get(data));
      this._pendingGets = [];
      this._fire('change', {data: data.data, version: data.version});
    });
  }

  async cloneFrom(store) {
    let {data, version} = await store._getWithVersion();
    await realTransaction(this.reference, data => ({data, version}));
    this.description = store.description;
  }

  async get() {
    return this.dataSnapshot.val().data;
  }

  async _getWithVersion() {
    if (this.dataSnapshot == undefined) {
      return new Promise((resolve, reject) => {
        this._pendingGets.push(resolve);
      });
    }
    return this.dataSnapshot.val();
  }

  async set(value) {
    return realTransaction(this.reference, data => ({data: value, version: data.version + 1}));
  }

  async clear() {
    return this.set(null);
  }
}

class FirebaseCollection extends FirebaseStorageProvider {
  constructor(type, arc, id, reference, firebaseKey) {
    super(type, arc, id, reference, firebaseKey);
    this.dataSnapshot = undefined;
    this._pendingGets = [];
    this.reference.on('value', dataSnapshot => {
      this.dataSnapshot = dataSnapshot;
      let data = dataSnapshot.val();
      this._pendingGets.forEach(_get => _get(data));
      this._pendingGets = [];
      this._fire('change', {data: this._setToList(data.data), version: data.version});
    });
  }

  async get(id) {
    var set = this.dataSnapshot.val().data;
    var encId = FirebaseStorageProvider.encodeKey(id);
    if (set)
      return set[encId];
    return undefined;
  }

  async remove(id) {
    return realTransaction(this.reference, data => {
      if (!data.data)
        data.data = {};
      var encId = FirebaseStorageProvider.encodeKey(id);
      data.data[encId] = null;
      data.version += 1;
      return data;
    });
  }

  async store(entity) {
    return realTransaction(this.reference, data => {
      if (!data.data)
        data.data = {};
      var encId = FirebaseStorageProvider.encodeKey(entity.id);
      data.data[encId] = entity;
      data.version += 1;
      return data;
    });
  }

  async cloneFrom(store) {
    let {list, version} = await store._toListWithVersion();
    return realTransaction(this.reference, data => {
      if (!data.data)
        data.data = {};
      list.forEach(item => {
        var encId = FirebaseStorageProvider.encodeKey(item.id);
        data.data[encId] = item;
      });
      data.version = version;
      return data;
    });
    this.description = store.description;
  }

  async toList() {
    if (this.dataSnapshot == undefined) {
      return new Promise((resolve, reject) => {
        this._pendingGets.push(resolve);
      }).then(data => this._setToList(data.data));
    }
    return this._setToList(this.dataSnapshot.val().data);
  }

  async _toListWithVersion() {
    if (this.dataSnapshot == undefined) {
      return new Promise((resolve, reject) => {
        this._pendingGets.push(resolve);
      }).then(data => ({list: this._setToList(data.data), version: data.version}));
    }
    let data = this.dataSnapshot.val();
    return {list: this._setToList(data.data), version: data.version};
  }

  _setToList(set) {
    var list = [];
    if (set) {
      for (let key in set) {
        list.push(set[key]);
      }
    }
    return list;
  }
}
