import * as webpack from 'webpack'

import { BabelLoaderTransformOptions, BabelPresetOptions } from 'babel-loader'
import { BrowserProfileName, StandardBrowserProfileName } from './browser.profile.name'
import {
  DEFAULT_BABEL_PLUGINS,
  DEFAULT_BABEL_PRESET_OPTIONS,
  DEFAULT_BROWSERS,
  DEFAULT_TARGET_INFO,
} from './defaults'

import { BabelLoaderCacheDirectoryOption } from './babel.multi.target.options'
import { BabelTargetOptions } from './babel.target.options'
import { DEV_SERVER_CLIENT } from './constants'

import Chunk = webpack.compilation.Chunk
import ChunkGroup = webpack.compilation.ChunkGroup
import Entrypoint = webpack.compilation.Entrypoint
import Module = webpack.compilation.Module


export type BabelTargetSource = Module | Chunk | ChunkGroup

/**
 * Represents a targeted transpilation output.
 *
 * Includes properties from {@link BabelTargetOptions}, but all properties are required.
 */
export type BabelTargetInfo = { [p in keyof BabelTargetOptions]: BabelTargetOptions[p] } & {
  readonly profileName: BrowserProfileName
  readonly options: BabelLoaderTransformOptions
}

// webpack doesn't actually export things from the `compilation` namespace, so can only use them to
// type checking, not anything at runtime like instanceof
// so, need to do this instead
const SIG = {
  module: [
    'disconnect',
    'unseal',
    'isEntryModule',
    'isInChunk',
  ],
  entrypoint: [
    'isInitial',
    'getFiles',
    'getRuntimeChunk',
    'setRuntimeChunk',
  ],
  chunk: [
    'hasRuntime',
    'canBeInitial',
    'isOnlyInitial',
    'hasEntryModule',
    'addModule',
    'removeModule',
    'setModules',
    'getNumberOfModules',
    'addGroup',
    'isInGroup',
    'canBeIntegrated',
  ],
  chunkGroup: [
    'unshiftChunk',
    'insertChunk',
    'pushChunk',
    'replaceChunk',
    'isInitial',
    'addChild',
    'getChildren',
    'getNumberOfChildren',
  ],
}

function hasSig(obj: any, sig: string[]): boolean {
  return sig.every(name => typeof obj[name] === 'function')
}

function isModule(obj: any): obj is Module {
  return hasSig(obj, SIG.module)
}

function isEntrypoint(obj: any): obj is Entrypoint {
  return hasSig(obj, SIG.entrypoint)
}

function isChunkGroup(obj: any): obj is ChunkGroup {
  return hasSig(obj, SIG.chunkGroup)
}

function isChunk(obj: any): obj is Chunk {
  return hasSig(obj, SIG.chunk)
}

export class BabelTarget implements BabelTargetInfo {

  public readonly profileName: BrowserProfileName
  public readonly key: string
  public readonly options: BabelLoaderTransformOptions
  public readonly tagAssetsWithKey: boolean
  public readonly browsers: string[]
  public readonly esModule: boolean
  public readonly noModule: boolean

  constructor(info: BabelTargetInfo) {
    Object.assign(this, info)
  }

  public getTargetedAssetName(name: string): string {
    return this.tagAssetsWithKey ? `${name}.${this.key}` : name
  }

  public getTargetedRequest(request: string): string {
    const tag = `babel-target=${this.key}`
    if (request.includes(tag)) {
      return request
    }

    // need to make separate "requests" for the dev server client, but using the query breaks it, so use a hash instead
    const joiner = request.startsWith(DEV_SERVER_CLIENT) ?
      '#' :
      request.includes('?') ? '&' : '?'
    return request + joiner + tag
  }

  public static isTaggedRequest(request: string): boolean {
    return /[?&]babel-target=\w+/.test(request)
  }

  public static getTargetFromTag(request: string, targets: BabelTarget[]): BabelTarget {
    if (!BabelTarget.isTaggedRequest(request)) {
      return null
    }
    const key = request.match(/\bbabel-target=(\w+)/)[1]
    return targets.find(target => target.key === key)
  }

  public static getTargetFromModule(module: Module): BabelTarget {
    if (module.options && module.options.babelTarget) {
      return module.options.babelTarget
    }

    if (!module.reasons) {
      return null
    }

    for (const reason of module.reasons) {
      if (reason.dependency && reason.dependency.babelTarget) {
        return reason.dependency.babelTarget
      }
      if (reason.module) {
        const target = BabelTarget.getTargetFromModule(reason.module)
        if (target) {
          return target
        }
      }
    }

    return null

  }

  public static getTargetFromEntrypoint(entrypoint: Entrypoint): BabelTarget {
    return BabelTarget.getTargetFromModule(entrypoint.runtimeChunk.entryModule)
  }

  public static getTargetFromGroup(group: ChunkGroup): BabelTarget {
    return null
  }

  public static getTargetFromChunk(chunk: Chunk): BabelTarget {
    if (chunk.entryModule) {
      return BabelTarget.getTargetFromModule(chunk.entryModule)
    }

    return null
  }

  public static findTarget(source: BabelTargetSource): BabelTarget {

    if (isModule(source)) {
      return BabelTarget.getTargetFromModule(source)
    }
    if (isEntrypoint(source)) {
      return BabelTarget.getTargetFromEntrypoint(source)
    }
    if (isChunkGroup(source)) {
      return BabelTarget.getTargetFromGroup(source)
    }
    if (isChunk(source)) {
      return BabelTarget.getTargetFromChunk(source)
    }

    return null
  }
}

export class BabelTargetFactory {

  constructor(private presetOptions: BabelPresetOptions, private presets: string[], private plugins: string[]) {
  }

  public createBabelTarget(profileName: BrowserProfileName, options: BabelTargetOptions, loaderOptions: { cacheDirectory?: BabelLoaderCacheDirectoryOption } ) {
    const browsers = options.browsers || DEFAULT_BROWSERS[profileName]
    const key = options.key || profileName

    const info: BabelTargetInfo = Object.assign(
      {},
      DEFAULT_TARGET_INFO[profileName as StandardBrowserProfileName],
      options,
      {
        profileName,
        browsers,
        key,
        options: this.createTransformOptions(key, browsers, loaderOptions),
      },
    )

    return new BabelTarget(info)
  }

  public createTransformOptions(key: string, browsers: string[], loaderOptions: { cacheDirectory?: BabelLoaderCacheDirectoryOption }): BabelLoaderTransformOptions {

    const mergedPresetOptions: BabelPresetOptions = Object.assign(
      {},
      DEFAULT_BABEL_PRESET_OPTIONS,
      this.presetOptions,
      {
        targets: {
          browsers,
        },
      }, {
        modules: false,
      }
    )

    const cacheDirectory = this.getCacheDirectory(key, loaderOptions.cacheDirectory)

    return {
      presets: [
        ['@babel/preset-env', mergedPresetOptions],
        ...this.presets
      ],
      plugins: [
        ...DEFAULT_BABEL_PLUGINS,
        ...this.plugins,
      ],
      cacheDirectory,
    }

  }

  private getCacheDirectory(key: string, option: BabelLoaderCacheDirectoryOption): string {
    if (option === false) {
      return undefined;
    }
    if (option === true || typeof option === 'undefined') {
      return `node_modules/.cache/babel-loader/${key}`
    }
    if (typeof option === 'function') {
      return option(key)
    }

    return option
  }
}
