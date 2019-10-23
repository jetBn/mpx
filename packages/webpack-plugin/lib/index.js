'use strict'

const path = require('path')
const ConcatSource = require('webpack-sources').ConcatSource
const ResolveDependency = require('./dependency/ResolveDependency')
const InjectDependency = require('./dependency/InjectDependency')
const ReplaceDependency = require('./dependency/ReplaceDependency')
const NullFactory = require('webpack/lib/NullFactory')
const normalize = require('./utils/normalize')
const toPosix = require('./utils/to-posix')
const getResource = require('./utils/parse-request')
const addQuery = require('./utils/add-query')
const DefinePlugin = require('webpack/lib/DefinePlugin')
const AddModePlugin = require('./resolver/AddModePlugin')
const CommonJsRequireDependency = require('webpack/lib/dependencies/CommonJsRequireDependency')
const HarmonyImportSideEffectDependency = require('webpack/lib/dependencies/HarmonyImportSideEffectDependency')
const RequireHeaderDependency = require('webpack/lib/dependencies/RequireHeaderDependency')
const RemovedModuleDependency = require('./dependency/RemovedModuleDependency')
const SplitChunksPlugin = require('webpack/lib/optimize/SplitChunksPlugin')
const fixRelative = require('./utils/fix-relative')
const parseRequest = require('./utils/parse-request')
const normalizeCondition = require('./utils/normalize-condition')

const isProductionLikeMode = options => {
  return options.mode === 'production' || !options.mode
}

const outputFilename = '[name].js'
const publicPath = '/'

function isChunkInPackage (chunkName, packageName) {
  return (new RegExp(`^${packageName}\\/`)).test(chunkName)
}

function getPackageCacheGroup (packageName) {
  if (packageName === 'main') {
    return {
      name: 'bundle',
      minChunks: 2,
      chunks: 'initial'
    }
  } else {
    return {
      test: (module, chunks) => {
        return chunks.every((chunk) => {
          return isChunkInPackage(chunk.name, packageName)
        })
      },
      name: `${packageName}/bundle`,
      minChunks: 2,
      minSize: 1000,
      priority: 100,
      chunks: 'initial'
    }
  }
}

let loaderOptions

class MpxWebpackPlugin {
  constructor (options = {}) {
    options.mode = options.mode || 'wx'

    options.srcMode = options.srcMode || options.mode
    if (options.mode !== options.srcMode && options.srcMode !== 'wx') {
      throw new Error('MpxWebpackPlugin supports srcMode to be "wx" only temporarily!')
    }
    if (!Array.isArray(options.externalClasses)) {
      options.externalClasses = ['custom-class', 'i-class']
    }

    options.externalClasses = options.externalClasses.map((className) => {
      return {
        className,
        replacement: className.replace(/-(.)/g, (matched, $1) => {
          return $1.toUpperCase()
        })
      }
    })
    options.resolveMode = options.resolveMode || 'webpack'
    options.writeMode = options.writeMode || 'changed'
    options.enableAutoScope = options.enableAutoScope || false
    if (options.autoSplit === undefined) {
      options.autoSplit = true
    }
    // 批量指定源码mode
    options.modeRules = options.modeRules || {}
    this.options = options
  }

  static loader (options) {
    loaderOptions = options
    return { loader: normalize.lib('loader'), options }
  }

  static pluginLoader (options) {
    return { loader: normalize.lib('plugin-loader'), options }
  }

  static wxsPreLoader (options) {
    return { loader: normalize.lib('wxs/wxs-pre-loader'), options }
  }

  static urlLoader (options) {
    return { loader: normalize.lib('url-loader'), options }
  }

  static fileLoader (options) {
    return { loader: normalize.lib('file-loader'), options }
  }

  runModeRules (request) {
    const { resourcePath, queryObj } = parseRequest(request)
    if (queryObj.mode) {
      return request
    }
    const mode = this.options.mode
    const modeRule = this.options.modeRules[mode]
    if (!modeRule) {
      return request
    }
    const include = modeRule.include
    const exclude = modeRule.exclude

    const matchInclude = include && normalizeCondition(include)
    const matchExclude = exclude && normalizeCondition(exclude)

    let needAddMode = false
    if (matchInclude && !matchInclude(resourcePath)) {
      needAddMode = true
    }
    if (matchExclude && matchExclude(resourcePath)) {
      needAddMode = false
    }
    if (needAddMode) {
      return addQuery(request, { mode })
    }
    return request
  }

  apply (compiler) {
    // 强制设置publicPath为'/'
    if (compiler.options.output.publicPath && compiler.options.output.publicPath !== publicPath) {
      console.warn(`MpxWebpackPlugin accept output publicPath to be ${publicPath} only, custom output publicPath will be ignored!`)
    }
    compiler.options.output.publicPath = publicPath
    if (compiler.options.output.filename && compiler.options.output.filename !== outputFilename) {
      console.warn(`MpxWebpackPlugin accept output filename to be ${outputFilename} only, custom output filename will be ignored!`)
    }
    compiler.options.output.filename = compiler.options.output.chunkFilename = outputFilename

    const resolvePlugin = new AddModePlugin('before-resolve', this.options.mode, 'resolve')

    if (Array.isArray(compiler.options.resolve.plugins)) {
      compiler.options.resolve.plugins.push(resolvePlugin)
    } else {
      compiler.options.resolve.plugins = [resolvePlugin]
    }

    compiler.options.optimization.runtimeChunk = {
      name: 'bundle'
    }

    let splitChunksPlugin
    let splitChunksOptions = {
      cacheGroups: {
        main: {
          name: 'bundle',
          minChunks: 2,
          chunks: 'initial'
        }
      }
    }

    if (this.options.autoSplit) {
      if (compiler.options.optimization.splitChunks) {
        splitChunksOptions = compiler.options.optimization.splitChunks
        delete compiler.options.optimization.splitChunks
      }
      splitChunksPlugin = new SplitChunksPlugin(splitChunksOptions)
      splitChunksPlugin.apply(compiler)
    }

    // 代理writeFile
    if (this.options.writeMode === 'changed') {
      const writedFileContentMap = new Map()
      const originalWriteFile = compiler.outputFileSystem.writeFile
      compiler.outputFileSystem.writeFile = (filePath, content, callback) => {
        if (writedFileContentMap.has(filePath) && writedFileContentMap.get(filePath).equals(content)) {
          return callback()
        }
        writedFileContentMap.set(filePath, content)
        originalWriteFile(filePath, content, callback)
      }
    }

    // define mode
    new DefinePlugin({
      '__mpx_mode__': JSON.stringify(this.options.mode),
      '__mpx_src_mode__': JSON.stringify(this.options.srcMode),
      '__mpx_wxs__': DefinePlugin.runtimeValue(({ module }) => {
        return JSON.stringify(!!module.wxs)
      })
    }).apply(compiler)

    compiler.hooks.compilation.tap('MpxWebpackPlugin ', (compilation) => {
      compilation.hooks.normalModuleLoader.tap('MpxWebpackPlugin', (loaderContext, module) => {
        // 设置loaderContext的minimize
        if (isProductionLikeMode(compiler.options)) {
          loaderContext.minimize = true
        }
      })
    })

    let mpx

    compiler.hooks.thisCompilation.tap('MpxWebpackPlugin', (compilation, { normalModuleFactory }) => {
      // additionalAssets和mpx由于包含缓存机制，必须在每次compilation时重新初始化
      const additionalAssets = {}
      if (!compilation.__mpx__) {
        // init mpx
        mpx = compilation.__mpx__ = {
          // pages全局记录，无需区分主包分包
          pagesMap: {},
          // 组件资源记录，依照所属包进行记录，冗余存储，只要某个包有引用会添加对应记录，不管其会不会在当前包输出，这样设计主要是为了在resolve时能够以较低成本找到特定资源的输出路径
          componentsMap: {
            main: {}
          },
          // 静态资源(图片，字体，独立样式)等，依照所属包进行记录，冗余存储，同上
          staticResourceMap: {
            main: {}
          },
          hasApp: false,
          // 记录静态资源首次命中的分包，当有其他分包再次引用了同样的静态资源时，对其request添加packageName query以避免模块缓存导致loader不再执行
          staticResourceHit: {},
          loaderOptions,
          extractedMap: {},
          extractSeenFile: {},
          usingComponents: [],
          currentPackageRoot: '',
          wxsMap: {},
          wxsConentMap: {},
          forceDisableInject: this.options.forceDisableInject,
          resolveMode: this.options.resolveMode,
          mode: this.options.mode,
          srcMode: this.options.srcMode,
          externalClasses: this.options.externalClasses,
          projectRoot: this.options.projectRoot,
          enableAutoScope: this.options.enableAutoScope,
          extract: (content, file, index, sideEffects) => {
            additionalAssets[file] = additionalAssets[file] || []
            if (!additionalAssets[file][index]) {
              additionalAssets[file][index] = content
            }
            sideEffects && sideEffects(additionalAssets)
          },
          // 组件和静态资源的输出规则如下：
          // 1. 主包引用的资源输出至主包
          // 2. 分包引用且主包引用过的资源输出至主包，不在当前分包重复输出
          // 3. 分包引用且无其他包引用的资源输出至当前分包
          // 4. 分包引用且其他分包也引用过的资源，重复输出至当前分包
          // 5. 当用户通过packageName query显式指定了资源的所属包时，输出至指定的包
          getPackageInfo (resource, { outputPath, isStatic, error }) {
            let packageRoot = ''
            let packageName = 'main'
            const currentPackageRoot = mpx.currentPackageRoot
            const currentPackageName = currentPackageRoot || 'main'
            const { resourcePath, queryObj } = parseRequest(resource)
            const resourceMap = isStatic ? mpx.staticResourceMap : mpx.componentsMap
            if (queryObj.packageName) {
              packageName = queryObj.packageName
              packageRoot = packageName === 'main' ? '' : packageName
              if (packageName !== currentPackageName && packageName !== 'main') {
                error && error(new Error(`根据小程序分包资源引用规则，资源只支持声明为当前分包或者主包，否则可能会导致资源无法引用的问题，当前资源的当前分包为${currentPackageName}，资源查询字符串声明的分包为${packageName}，请检查！`))
              }
            } else if (currentPackageRoot) {
              if (!resourceMap.main[resourcePath]) {
                packageName = packageRoot = mpx.currentPackageRoot
              }
            }

            outputPath = toPosix(path.join(packageRoot, outputPath))

            const currentResourceMap = resourceMap[currentPackageName]
            const actualResourceMap = resourceMap[packageName]

            let alreadyOutputed = false
            // 如果之前已经进行过输出，则不需要重复进行
            if (actualResourceMap[resourcePath]) {
              outputPath = actualResourceMap[resourcePath]
              alreadyOutputed = true
            }
            // 将当前的currentResourceMap和实际进行输出的actualResourceMap都填充上，便于resolve时使用
            currentResourceMap[resourcePath] = actualResourceMap[resourcePath] = outputPath

            if (isStatic && packageName !== 'main' && !mpx.staticResourceHit[resourcePath]) {
              mpx.staticResourceHit[resourcePath] = packageName
            }

            return {
              packageName,
              packageRoot,
              resourcePath,
              queryObj,
              outputPath,
              alreadyOutputed
            }
          }
        }
      }

      if (splitChunksPlugin) {
        // 自动跟进分包配置修改splitChunksPlugin配置
        compilation.hooks.finishModules.tap('MpxWebpackPlugin', (modules) => {
          let needInit = false
          Object.keys(mpx.componentsMap).forEach((packageName) => {
            if (!splitChunksOptions.cacheGroups.hasOwnProperty(packageName)) {
              needInit = true
              splitChunksOptions.cacheGroups[packageName] = getPackageCacheGroup(packageName)
            }
          })
          if (needInit) {
            splitChunksPlugin.options = SplitChunksPlugin.normalizeOptions(splitChunksOptions)
          }
        })
      }

      compilation.hooks.optimizeModules.tap('MpxWebpackPlugin', (modules) => {
        modules.forEach((module) => {
          if (module.needRemove) {
            let removed = false
            module.reasons.forEach((reason) => {
              if (reason.module) {
                if (reason.dependency instanceof HarmonyImportSideEffectDependency) {
                  reason.module.removeDependency(reason.dependency)
                  reason.module.addDependency(new RemovedModuleDependency(reason.dependency.request))
                  removed = true
                } else if (reason.dependency instanceof CommonJsRequireDependency && reason.dependency.loc.range) {
                  let index = reason.module.dependencies.indexOf(reason.dependency)
                  if (index > -1 && reason.module.dependencies[index + 1] instanceof RequireHeaderDependency) {
                    reason.module.dependencies.splice(index, 2)
                    reason.module.addDependency(new RemovedModuleDependency(reason.dependency.request, reason.dependency.loc.range))
                    removed = true
                  }
                }
              }
            })
            if (removed) {
              module.chunksIterable.forEach((chunk) => {
                module.removeChunk(chunk)
              })
              module.disconnect()
            }
          }
        })
      })

      compilation.hooks.additionalAssets.tapAsync('MpxWebpackPlugin', (callback) => {
        for (let file in additionalAssets) {
          let content = new ConcatSource()
          if (additionalAssets[file].prefix) {
            additionalAssets[file].prefix.forEach((item) => {
              content.add(item)
            })
          }
          additionalAssets[file].forEach((item) => {
            content.add(item)
          })
          compilation.assets[file] = content
        }
        callback()
      })

      compilation.dependencyFactories.set(ResolveDependency, new NullFactory())
      compilation.dependencyTemplates.set(ResolveDependency, new ResolveDependency.Template())

      compilation.dependencyFactories.set(InjectDependency, new NullFactory())
      compilation.dependencyTemplates.set(InjectDependency, new InjectDependency.Template())

      compilation.dependencyFactories.set(ReplaceDependency, new NullFactory())
      compilation.dependencyTemplates.set(ReplaceDependency, new ReplaceDependency.Template())

      compilation.dependencyFactories.set(RemovedModuleDependency, normalModuleFactory)
      compilation.dependencyTemplates.set(RemovedModuleDependency, new RemovedModuleDependency.Template())

      normalModuleFactory.hooks.parser.for('javascript/auto').tap('MpxWebpackPlugin', (parser) => {
        // hack预处理，将expr.range写入loc中便于在CommonJsRequireDependency中获取，移除无效require
        parser.hooks.call.for('require').tap({ name: 'MpxWebpackPlugin', stage: -100 }, (expr) => {
          expr.loc.range = expr.range
        })

        parser.hooks.call.for('__mpx_resolve_path__').tap('MpxWebpackPlugin', (expr) => {
          if (expr.arguments[0]) {
            const resource = expr.arguments[0].value
            const { queryObj } = parseRequest(resource)
            const packageName = queryObj.packageName
            const pagesMap = mpx.pagesMap
            const componentsMap = mpx.componentsMap
            const staticResourceMap = mpx.staticResourceMap
            const publicPath = compilation.outputOptions.publicPath || ''
            const range = expr.range
            const dep = new ResolveDependency(resource, packageName, pagesMap, componentsMap, staticResourceMap, publicPath, range)
            parser.state.current.addDependency(dep)
            return true
          }
        })

        const transHandler = (expr) => {
          const module = parser.state.module
          const current = parser.state.current
          const resource = module.resource
          const { queryObj } = parseRequest(resource)
          const localSrcMode = queryObj.mode
          const globalSrcMode = this.options.srcMode
          const srcMode = localSrcMode || globalSrcMode
          const mode = this.options.mode

          let target

          if (expr.type === 'Identifier') {
            target = expr
          } else if (expr.type === 'MemberExpression') {
            target = expr.object
          }
          if (/[/\\]@mpxjs[/\\]/.test(resource) || !target || mode === srcMode) {
            return
          }

          const type = target.name

          const name = type === 'wx' ? 'mpx' : 'createFactory'
          const replaceContent = type === 'wx' ? 'mpx' : `${name}(${JSON.stringify(type)})`

          const dep = new ReplaceDependency(replaceContent, target.range)
          current.addDependency(dep)

          let needInject = true
          for (let v of module.variables) {
            if (v.name === name) {
              needInject = false
              break
            }
          }
          if (needInject) {
            const expression = `require(${JSON.stringify(`@mpxjs/core/src/runtime/${name}`)})`
            const deps = []
            parser.parse(expression, {
              current: {
                addDependency: dep => {
                  dep.userRequest = name
                  deps.push(dep)
                }
              },
              module
            })
            current.addVariable(name, expression, deps)
          }
        }

        // hack babel polyfill global
        parser.hooks.evaluate.for('CallExpression').tap('MpxWebpackPlugin', (expr) => {
          const current = parser.state.current
          const arg0 = expr.arguments[0]
          const callee = expr.callee
          if (arg0 && arg0.value === 'return this' && callee.name === 'Function' && current.rawRequest === './_global') {
            current.addDependency(new InjectDependency({
              content: '(function() { return this })() || ',
              index: expr.range[0]
            }))
          }
        })

        const srcMode = this.options.srcMode
        if (srcMode !== this.options.mode) {
          parser.hooks.evaluate.for('MemberExpression').tap('MpxWebpackPlugin', (expr) => {
            // Undeclared varible for wx[identifier]()
            // TODO Unable to handle wx[identifier]
            if (expr.object.name === 'wx' && !parser.scope.definitions.has('wx')) {
              transHandler(expr)
            }
          })
          // Trans for wx.xx, wx['xx'], wx.xx(), wx['xx']()
          parser.hooks.expressionAnyMember.for('wx').tap('MpxWebpackPlugin', transHandler)
          parser.hooks.call.for('Page').tap('MpxWebpackPlugin', (expr) => {
            transHandler(expr.callee)
          })
          parser.hooks.call.for('Component').tap('MpxWebpackPlugin', (expr) => {
            transHandler(expr.callee)
          })
          parser.hooks.call.for('App').tap('MpxWebpackPlugin', (expr) => {
            transHandler(expr.callee)
          })
          if (this.options.mode === 'ali') {
            // 支付宝不支持Behaviors
            parser.hooks.call.for('Behavior').tap('MpxWebpackPlugin', (expr) => {
              transHandler(expr.callee)
            })
          }
        }

        const apiBlackListMap = [
          'createApp',
          'createPage',
          'createComponent',
          'createStore',
          'toPureObject',
          'mixin: injectMixins',
          'injectMixins',
          'observable',
          'extendObservable',
          'watch',
          'use',
          'set',
          'get',
          'remove',
          'setConvertRule',
          'createAction'
        ].reduce((map, api) => {
          map[api] = true
          return map
        }, {})

        const handler = (expr) => {
          const callee = expr.callee
          const args = expr.arguments
          const name = callee.object.name

          if (apiBlackListMap[callee.property.name || callee.property.value] || (name !== 'mpx' && name !== 'wx')) {
            return
          }
          const resource = parser.state.module.resource
          const { queryObj } = parseRequest(resource)
          const localSrcMode = queryObj.mode
          const globalSrcMode = this.options.srcMode
          const srcMode = localSrcMode || globalSrcMode
          const srcModeString = `__mpx_src_mode_${srcMode}__`
          const dep = new InjectDependency({
            content: args.length
              ? `, ${JSON.stringify(srcModeString)}`
              : JSON.stringify(srcModeString),
            index: expr.end - 1
          })
          parser.state.current.addDependency(dep)
        }

        if (this.options.srcMode !== this.options.mode) {
          parser.hooks.callAnyMember.for('imported var').tap('MpxWebpackPlugin', handler)
          parser.hooks.callAnyMember.for('mpx').tap('MpxWebpackPlugin', handler)
          parser.hooks.callAnyMember.for('wx').tap('MpxWebpackPlugin', handler)
        }
      })
    })

    compiler.hooks.normalModuleFactory.tap('MpxWebpackPlugin', (normalModuleFactory) => {
      // resolve前修改原始request
      normalModuleFactory.hooks.beforeResolve.tapAsync('MpxWebpackPlugin', (data, callback) => {
        let request = data.request
        let { queryObj, resource } = parseRequest(request)
        if (queryObj.resolve) {
          // 此处的query用于将资源引用的当前包信息传递给resolveDependency
          const pathLoader = normalize.lib('path-loader')
          const packageName = mpx.currentPackageRoot || 'main'
          resource = addQuery(resource, {
            packageName
          })
          data.request = `!!${pathLoader}!${resource}`
        } else if (queryObj.wxsModule) {
          const wxsPreLoader = normalize.lib('wxs/wxs-pre-loader')
          if (!/wxs-loader/.test(request)) {
            data.request = `!!${wxsPreLoader}!${resource}`
          }
        }
        callback(null, data)
      })

      // resolve完成后修改loaders或者resource/request
      normalModuleFactory.hooks.afterResolve.tapAsync('MpxWebpackPlugin', (data, callback) => {
        const isFromMpx = /\.(mpx|vue)/.test(data.resource)
        if (data.loaders) {
          data.loaders.forEach((loader) => {
            if (/ts-loader/.test(loader.loader) && isFromMpx) {
              loader.options = Object.assign({}, { appendTsSuffixTo: [/\.(mpx|vue)$/] })
            }
          })
        }
        // 根据用户传入的modeRules对特定资源添加mode query
        data.resource = this.runModeRules(data.resource)

        if (mpx.currentPackageRoot) {
          const resourcPath = getResource(data.resource)

          const staticResourceHit = mpx.staticResourceHit
          const packageName = mpx.currentPackageRoot || 'main'

          let needAddQuery = false

          if (staticResourceHit[resourcPath] && staticResourceHit[resourcPath] !== packageName) {
            needAddQuery = true
          }

          if (needAddQuery) {
            // 此处的query用于避免模块缓存
            data.request = addQuery(data.request, {
              packageName
            })
          }
        }
        callback(null, data)
      })
    })

    compiler.hooks.emit.tapAsync('MpxWebpackPlugin', (compilation, callback) => {
      const jsonpFunction = compilation.outputOptions.jsonpFunction

      function getTargetFile (file) {
        let targetFile = file
        const queryStringIdx = targetFile.indexOf('?')
        if (queryStringIdx >= 0) {
          targetFile = targetFile.substr(0, queryStringIdx)
        }
        return targetFile
      }

      const processedChunk = new Set()
      const rootName = compilation._preparedEntrypoints[0].name

      function processChunk (chunk, isRuntime, relativeChunks) {
        if (!chunk.files[0] || processedChunk.has(chunk)) {
          return
        }

        let originalSource = compilation.assets[chunk.files[0]]
        const source = new ConcatSource()
        source.add('\nvar window = window || {};\n\n')

        relativeChunks.forEach((relativeChunk, index) => {
          if (!relativeChunk.files[0]) return
          let chunkPath = getTargetFile(chunk.files[0])
          let relativePath = getTargetFile(relativeChunk.files[0])
          relativePath = path.relative(path.dirname(chunkPath), relativePath)
          relativePath = fixRelative(relativePath, mpx.mode)
          relativePath = toPosix(relativePath)
          if (index === 0) {
            // 引用runtime
            // 支付宝分包独立打包，通过全局context获取webpackJSONP
            if (mpx.mode === 'ali') {
              if (chunk.name === rootName) {
                // 在rootChunk中挂载jsonpFunction
                source.add('// process ali subpackages runtime in root chunk\n' +
                  'var context = (function() { return this })() || Function("return this")();\n\n')
                source.add(`context[${JSON.stringify(jsonpFunction)}] = window[${JSON.stringify(jsonpFunction)}] = require("${relativePath}");\n`)
              } else {
                // 其余chunk中通过context全局传递runtime
                source.add('// process ali subpackages runtime in other chunk\n' +
                  'var context = (function() { return this })() || Function("return this")();\n\n')
                source.add(`window[${JSON.stringify(jsonpFunction)}] = context[${JSON.stringify(jsonpFunction)}];\n`)
              }
            } else {
              source.add(`window[${JSON.stringify(jsonpFunction)}] = require("${relativePath}");\n`)
            }
          } else {
            source.add(`require("${relativePath}");\n`)
          }
        })

        if (isRuntime) {
          source.add('var context = (function() { return this })() || Function("return this")();\n' +
            'if(!context.console) context.console = console;\n\n')
          if (mpx.mode === 'swan') {
            source.add('// swan runtime fix\n' +
              'if (!context.navigator) {\n' +
              '  context.navigator = {};\n' +
              '}\n' +
              'Object.defineProperty(context.navigator, "standalone",{\n' +
              '  configurable: true,' +
              '  enumerable: true,' +
              '  get () {\n' +
              '    return true;\n' +
              '  }\n' +
              '});\n\n')
          }
          source.add(originalSource)
          source.add(`\nmodule.exports = window[${JSON.stringify(jsonpFunction)}];\n`)
        } else {
          if (mpx.pluginMain === chunk.name) {
            source.add('module.exports =\n')
          }
          source.add(originalSource)
        }

        compilation.assets[chunk.files[0]] = source
        processedChunk.add(chunk)
      }

      compilation.chunkGroups.forEach((chunkGroup) => {
        if (!chunkGroup.isInitial()) {
          return
        }

        let runtimeChunk, entryChunk
        let middleChunks = []

        let chunksLength = chunkGroup.chunks.length

        chunkGroup.chunks.forEach((chunk, index) => {
          if (index === 0) {
            runtimeChunk = chunk
          } else if (index === chunksLength - 1) {
            entryChunk = chunk
          } else {
            middleChunks.push(chunk)
          }
        })

        if (runtimeChunk) {
          processChunk(runtimeChunk, true, [])
          if (middleChunks.length) {
            middleChunks.forEach((middleChunk) => {
              processChunk(middleChunk, false, [runtimeChunk])
            })
          }
          if (entryChunk) {
            middleChunks.unshift(runtimeChunk)
            processChunk(entryChunk, false, middleChunks)
          }
        }
      })
      callback()
    })
  }
}

module.exports = MpxWebpackPlugin
