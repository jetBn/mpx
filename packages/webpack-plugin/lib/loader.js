const hash = require('hash-sum')
const parseComponent = require('./parser')
const createHelpers = require('./helpers')
const loaderUtils = require('loader-utils')
const InjectDependency = require('./dependency/InjectDependency')
const parseRequest = require('./utils/parse-request')
const matchCondition = require('./utils/match-condition')
const fixUsingComponent = require('./utils/fix-using-component')
const addQuery = require('./utils/add-query')
const async = require('async')
const processJSON = require('./web/processJSON')
const processScript = require('./web/processScript')
const processStyles = require('./web/processStyles')
const processTemplate = require('./web/processTemplate')
const readJsonForSrc = require('./utils/read-json-for-src')
const normalize = require('./utils/normalize')

module.exports = function (content) {
  this.cacheable()

  const mpx = this._compilation.__mpx__
  if (!mpx) {
    return content
  }
  const packageName = mpx.currentPackageRoot || 'main'
  const pagesMap = mpx.pagesMap
  const componentsMap = mpx.componentsMap[packageName]
  const resolveMode = mpx.resolveMode
  const projectRoot = mpx.projectRoot
  const mode = mpx.mode
  const defs = mpx.defs
  const i18n = mpx.i18n
  const globalSrcMode = mpx.srcMode
  const localSrcMode = loaderUtils.parseQuery(this.resourceQuery || '?').mode
  const resourcePath = parseRequest(this.resource).resourcePath
  const srcMode = localSrcMode || globalSrcMode
  const vueContentCache = mpx.vueContentCache
  const autoScope = matchCondition(resourcePath, mpx.autoScopeRules)

  const resourceQueryObj = loaderUtils.parseQuery(this.resourceQuery || '?')

  // 支持资源query传入page或component支持页面/组件单独编译
  if ((resourceQueryObj.component && !componentsMap[resourcePath]) || (resourceQueryObj.page && !pagesMap[resourcePath])) {
    let entryChunkName
    const rawRequest = this._module.rawRequest
    const _preparedEntrypoints = this._compilation._preparedEntrypoints
    for (let i = 0; i < _preparedEntrypoints.length; i++) {
      if (rawRequest === _preparedEntrypoints[i].request) {
        entryChunkName = _preparedEntrypoints[i].name
        break
      }
    }
    if (resourceQueryObj.component) {
      componentsMap[resourcePath] = entryChunkName || 'noEntryComponent'
    } else {
      pagesMap[resourcePath] = entryChunkName || 'noEntryPage'
    }
  }

  let ctorType = 'app'
  if (pagesMap[resourcePath]) {
    // page
    ctorType = 'page'
  } else if (componentsMap[resourcePath]) {
    // component
    ctorType = 'component'
  }

  const loaderContext = this
  const stringifyRequest = r => loaderUtils.stringifyRequest(loaderContext, r)
  const isProduction = this.minimize || process.env.NODE_ENV === 'production'
  const options = loaderUtils.getOptions(this) || {}

  const filePath = this.resourcePath

  const moduleId = 'm' + hash(this._module.identifier())

  const needCssSourceMap = (
    !isProduction &&
    this.sourceMap &&
    options.cssSourceMap !== false
  )

  const parts = parseComponent(content, filePath, this.sourceMap, mode, defs)

  let output = ''
  const callback = this.async()

  async.waterfall([
    (callback) => {
      const json = parts.json || {}
      if (json.src) {
        readJsonForSrc(json.src, loaderContext, (err, result) => {
          if (err) return callback(err)
          json.content = result
          callback()
        })
      } else {
        callback()
      }
    },
    (callback) => {
      // web输出模式下没有任何inject，可以通过cache直接返回，由于读取src json可能会新增模块依赖，需要在之后返回缓存内容
      if (vueContentCache.has(filePath)) {
        return callback(null, vueContentCache.get(filePath))
      }
      // 只有ali才可能需要scoped
      const hasScoped = (parts.styles.some(({ scoped }) => scoped) || autoScope) && mode === 'ali'
      const templateAttrs = parts.template && parts.template.attrs
      const hasComment = templateAttrs && templateAttrs.comments
      const isNative = false

      let usingComponents = [].concat(Object.keys(mpx.usingComponents))

      if (parts.json && parts.json.content) {
        try {
          let ret = JSON.parse(parts.json.content)
          if (ret.usingComponents) {
            fixUsingComponent({ usingComponents: ret.usingComponents, mode })
            usingComponents = usingComponents.concat(Object.keys(ret.usingComponents))
          }
        } catch (e) {
          return callback(e)
        }
      }

      const {
        getRequire,
        getNamedExports,
        getRequireForSrc,
        getNamedExportsForSrc
      } = createHelpers(
        loaderContext,
        options,
        moduleId,
        isProduction,
        hasScoped,
        hasComment,
        usingComponents,
        needCssSourceMap,
        srcMode,
        isNative,
        projectRoot
      )

      // 处理mode为web时输出vue格式文件
      if (mode === 'web') {
        if (ctorType === 'app' && !resourceQueryObj.app) {
          const request = addQuery(this.resource, { app: true })
          output += `
      import App from ${stringifyRequest(request)}
      import Vue from 'vue'
      new Vue({
        el: '#app',
        render: function(h){
          return h(App)
        }
      })\n
      `
          // 直接结束loader进入parse
          this.loaderIndex = -1
          return callback(null, output)
        }

        return async.waterfall([
          (callback) => {
            async.parallel([
              (callback) => {
                processTemplate(parts.template, {
                  mode,
                  srcMode,
                  defs,
                  loaderContext,
                  ctorType
                }, callback)
              },
              (callback) => {
                processStyles(parts.styles, {
                  ctorType
                }, callback)
              },
              (callback) => {
                processJSON(parts.json, {
                  mode,
                  defs,
                  resolveMode,
                  loaderContext,
                  pagesMap,
                  pagesEntryMap: mpx.pagesEntryMap,
                  componentsMap,
                  projectRoot
                }, callback)
              }
            ], (err, res) => {
              callback(err, res)
            })
          },
          ([templateRes, stylesRes, jsonRes], callback) => {
            output += templateRes.output
            output += stylesRes.output
            output += jsonRes.output
            if (ctorType === 'app' && jsonRes.jsonObj.window && jsonRes.jsonObj.window.navigationBarTitleText) {
              mpx.appTitle = jsonRes.jsonObj.window.navigationBarTitleText
            }

            let pageTitle = ''
            if (ctorType === 'page' && jsonRes.jsonObj.navigationBarTitleText) {
              pageTitle = jsonRes.jsonObj.navigationBarTitleText
            }

            processScript(parts.script, {
              ctorType,
              srcMode,
              loaderContext,
              isProduction,
              getRequireForSrc,
              i18n,
              pageTitle,
              mpxCid: resourceQueryObj.mpxCid,
              builtInComponentsMap: templateRes.builtInComponentsMap,
              localComponentsMap: jsonRes.localComponentsMap,
              localPagesMap: jsonRes.localPagesMap
            }, callback)
          }
        ], (err, scriptRes) => {
          if (err) return callback(err)
          output += scriptRes.output
          vueContentCache.set(filePath, output)
          callback(null, output)
        })
      }

      // 触发webpack global var 注入
      output += 'global.currentModuleId\n'

      // todo loader中inject dep比较危险，watch模式下不一定靠谱，可考虑将import改为require然后通过修改loader内容注入
      // 注入模块id及资源路径
      let globalInjectCode = `global.currentModuleId = ${JSON.stringify(moduleId)}\n`
      if (!isProduction) {
        globalInjectCode += `global.currentResource = ${JSON.stringify(filePath)}\n`
      }
      if (ctorType === 'app' && i18n) {
        globalInjectCode += `global.i18n = ${JSON.stringify({ locale: i18n.locale })}\n`

        const i18nMethodsVar = 'i18nMethods'
        const i18nWxsPath = normalize.lib('runtime/i18n.wxs')
        const i18nWxsLoaderPath = normalize.lib('wxs/wxs-i18n-loader.js')
        const i18nWxsRequest = i18nWxsLoaderPath + '!' + i18nWxsPath
        const expression = `require(${loaderUtils.stringifyRequest(loaderContext, i18nWxsRequest)})`
        const deps = []
        this._module.parser.parse(expression, {
          current: {
            addDependency: dep => {
              dep.userRequest = i18nMethodsVar
              deps.push(dep)
            }
          },
          module: this._module
        })
        this._module.addVariable(i18nMethodsVar, expression, deps)

        globalInjectCode += `global.i18nMethods = ${i18nMethodsVar}\n`
      }
      // 注入构造函数
      let ctor = 'App'
      if (ctorType === 'page') {
        if (mpx.forceUsePageCtor || mode === 'ali') {
          ctor = 'Page'
        } else {
          ctor = 'Component'
        }
      } else if (ctorType === 'component') {
        ctor = 'Component'
      }
      globalInjectCode += `global.currentCtor = ${ctor}\n`
      globalInjectCode += `global.currentCtorType = ${JSON.stringify(ctor.replace(/^./, (match) => {
        return match.toLowerCase()
      }))}\n`

      //
      // <script>
      output += '/* script */\n'
      let scriptSrcMode = srcMode
      const script = parts.script
      if (script) {
        scriptSrcMode = script.mode || scriptSrcMode
        if (script.src) {
          // 传入resourcePath以确保后续处理中能够识别src引入的资源为组件主资源
          script.src = addQuery(script.src, { resourcePath })
          output += getNamedExportsForSrc('script', script) + '\n\n'
        } else {
          output += getNamedExports('script', script) + '\n\n'
        }
      } else {
        switch (ctorType) {
          case 'app':
            output += 'import {createApp} from "@mpxjs/core"\n' +
              'createApp({})\n'
            break
          case 'page':
            output += 'import {createPage} from "@mpxjs/core"\n' +
              'createPage({})\n'
            break
          case 'component':
            output += 'import {createComponent} from "@mpxjs/core"\n' +
              'createComponent({})\n'
        }
        output += '\n'
      }

      if (scriptSrcMode) {
        globalInjectCode += `global.currentSrcMode = ${JSON.stringify(scriptSrcMode)}\n`
      }

      // styles
      output += '/* styles */\n'
      let cssModules
      if (parts.styles.length) {
        let styleInjectionCode = ''
        parts.styles.forEach((style, i) => {
          let scoped = hasScoped ? (style.scoped || autoScope) : false
          // require style
          // todo style src会被特殊处理为全局复用样式，暂时不添加resourcePath，理论上在当前支持了@import样式复用后这里是可以添加resourcePath视为组件主资源的，后续待优化
          let requireString = style.src
            ? getRequireForSrc('styles', style, -1, scoped, undefined, true)
            : getRequire('styles', style, i, scoped)

          const hasStyleLoader = requireString.indexOf('style-loader') > -1
          const invokeStyle = code => `${code}\n`

          const moduleName = style.module === true ? '$style' : style.module
          // setCssModule
          if (moduleName) {
            if (!cssModules) {
              cssModules = {}
            }
            if (moduleName in cssModules) {
              loaderContext.emitError(
                'CSS module name "' + moduleName + '" is not unique!'
              )
              styleInjectionCode += invokeStyle(requireString)
            } else {
              cssModules[moduleName] = true

              if (!hasStyleLoader) {
                requireString += '.locals'
              }

              styleInjectionCode += invokeStyle(
                'this["' + moduleName + '"] = ' + requireString
              )
            }
          } else {
            styleInjectionCode += invokeStyle(requireString)
          }
        })
        output += styleInjectionCode + '\n'
      }

      // json
      output += '/* json */\n'
      // 给予json默认值, 确保生成json request以自动补全json
      const json = parts.json || {}
      if (json.src) {
        json.src = addQuery(json.src, { resourcePath, __component: true })
        output += getRequireForSrc('json', json) + '\n\n'
      } else {
        output += getRequire('json', json) + '\n\n'
      }

      // template
      output += '/* template */\n'
      const template = parts.template

      if (template) {
        if (template.src) {
          template.src = addQuery(template.src, { resourcePath })
          output += getRequireForSrc('template', template) + '\n\n'
        } else {
          output += getRequire('template', template) + '\n\n'
        }
      }

      if (!mpx.forceDisableInject) {
        const dep = new InjectDependency({
          content: globalInjectCode,
          index: -3
        })
        this._module.addDependency(dep)
      }

      callback(null, output)
    }
  ], callback)
}
