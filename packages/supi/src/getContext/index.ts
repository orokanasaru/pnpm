import { packageManifestLogger } from '@pnpm/core-loggers'
import PnpmError from '@pnpm/error'
import { Lockfile } from '@pnpm/lockfile-file'
import logger from '@pnpm/logger'
import {
  IncludedDependencies,
  Modules,
} from '@pnpm/modules-yaml'
import readImportersContext from '@pnpm/read-importers-context'
import {
  DEPENDENCIES_FIELDS,
  ImporterManifest,
  ReadPackageHook,
  Registries,
} from '@pnpm/types'
import rimraf = require('@zkochan/rimraf')
import fs = require('mz/fs')
import path = require('path')
import pathAbsolute = require('path-absolute')
import R = require('ramda')
import checkCompatibility from './checkCompatibility'
import readLockfileFile from './readLockfiles'

export interface PnpmContext<T> {
  currentLockfile: Lockfile,
  existsCurrentLockfile: boolean,
  existsWantedLockfile: boolean,
  extraBinPaths: string[],
  hoistedAliases: {[depPath: string]: string[]}
  importers: Array<{
    modulesDir: string,
    id: string,
  } & T & Required<ImportersOptions>>,
  include: IncludedDependencies,
  independentLeaves: boolean,
  modulesFile: Modules | null,
  pendingBuilds: string[],
  rootModulesDir: string,
  hoistPattern: string[] | undefined,
  hoistedModulesDir: string,
  lockfileDir: string,
  virtualStoreDir: string,
  shamefullyHoist: boolean,
  skipped: Set<string>,
  storeDir: string,
  wantedLockfile: Lockfile,
  registries: Registries,
}

export interface ImportersOptions {
  binsDir?: string,
  manifest: ImporterManifest,
  rootDir: string,
}

export default async function getContext<T> (
  importers: (ImportersOptions & T)[],
  opts: {
    force: boolean,
    forceSharedLockfile: boolean,
    extraBinPaths: string[],
    lockfileDir: string,
    hooks?: {
      readPackage?: ReadPackageHook,
    },
    include?: IncludedDependencies,
    registries: Registries,
    storeDir: string,
    useLockfile: boolean,
    virtualStoreDir?: string,

    independentLeaves?: boolean,
    forceIndependentLeaves?: boolean,

    hoistPattern?: string[] | undefined,
    forceHoistPattern?: boolean,

    shamefullyHoist?: boolean,
    forceShamefullyHoist?: boolean,
  },
): Promise<PnpmContext<T>> {
  const importersContext = await readImportersContext(importers, opts.lockfileDir)
  const virtualStoreDir = pathAbsolute(opts.virtualStoreDir ?? 'node_modules/.pnpm', opts.lockfileDir)

  if (importersContext.modules) {
    await validateNodeModules(importersContext.modules, importersContext.importers, {
      currentHoistPattern: importersContext.currentHoistPattern,
      force: opts.force,
      include: opts.include,
      lockfileDir: opts.lockfileDir,
      storeDir: opts.storeDir,
      virtualStoreDir,

      forceIndependentLeaves: opts.forceIndependentLeaves,
      independentLeaves: opts.independentLeaves,

      forceHoistPattern: opts.forceHoistPattern,
      hoistPattern: opts.hoistPattern,

      forceShamefullyHoist: opts.forceShamefullyHoist,
      shamefullyHoist: opts.shamefullyHoist,
    })
  }

  await fs.mkdir(opts.storeDir, { recursive: true })

  importers.forEach((importer) => {
    packageManifestLogger.debug({
      initial: importer.manifest,
      prefix: importer.rootDir,
    })
  })
  if (opts.hooks?.readPackage) {
    importers = importers.map((importer) => ({
      ...importer,
      manifest: opts.hooks!.readPackage!(importer.manifest),
    }))
  }

  const extraBinPaths = [
    ...opts.extraBinPaths || []
  ]
  const shamefullyHoist = Boolean(typeof importersContext.shamefullyHoist === 'undefined' ? opts.shamefullyHoist : importersContext.shamefullyHoist)
  if (opts.hoistPattern && !shamefullyHoist) {
    extraBinPaths.unshift(path.join(virtualStoreDir, 'node_modules/.bin'))
  }
  const hoistedModulesDir = shamefullyHoist
    ? importersContext.rootModulesDir : path.join(virtualStoreDir, 'node_modules')
  const ctx: PnpmContext<T> = {
    extraBinPaths,
    hoistedAliases: importersContext.hoistedAliases,
    hoistedModulesDir,
    hoistPattern: typeof importersContext.hoist === 'boolean' ?
      importersContext.currentHoistPattern : opts.hoistPattern,
    importers: importersContext.importers,
    include: opts.include || importersContext.include,
    independentLeaves: Boolean(typeof importersContext.independentLeaves === 'undefined' ? opts.independentLeaves : importersContext.independentLeaves),
    lockfileDir: opts.lockfileDir,
    modulesFile: importersContext.modules,
    pendingBuilds: importersContext.pendingBuilds,
    registries: {
      ...opts.registries,
      ...importersContext.registries,
    },
    rootModulesDir: importersContext.rootModulesDir,
    shamefullyHoist,
    skipped: importersContext.skipped,
    storeDir: opts.storeDir,
    virtualStoreDir,
    ...await readLockfileFile({
      force: opts.force,
      forceSharedLockfile: opts.forceSharedLockfile,
      importers: importersContext.importers,
      lockfileDir: opts.lockfileDir,
      registry: opts.registries.default,
      useLockfile: opts.useLockfile,
      virtualStoreDir,
    }),
  }

  return ctx
}

async function validateNodeModules (
  modules: Modules,
  importers: Array<{
    modulesDir: string,
    id: string,
    rootDir: string,
  }>,
  opts: {
    currentHoistPattern?: string[],
    force: boolean,
    include?: IncludedDependencies,
    lockfileDir: string,
    storeDir: string,
    virtualStoreDir: string,

    independentLeaves?: boolean,
    forceIndependentLeaves?: boolean,

    hoistPattern?: string[] | undefined,
    forceHoistPattern?: boolean,

    shamefullyHoist?: boolean | undefined,
    forceShamefullyHoist?: boolean,
  },
) {
  const rootImporter = importers.find(({ id }) => id === '.')
  if (opts.forceShamefullyHoist && modules.shamefullyHoist !== opts.shamefullyHoist) {
    if (opts.force && rootImporter) {
      await purgeModulesDirsOfImporter(rootImporter)
      return
    }
    if (modules.shamefullyHoist) {
      throw new PnpmError(
        'SHAMEFULLY_HOIST_WANTED',
        'This "node_modules" folder was created using the --shamefully-hoist option.'
        + ' You must add that option, or else run "pnpm install --force" to recreate the "node_modules" folder.',
      )
    }
    throw new PnpmError(
      'SHAMEFULLY_HOIST_NOT_WANTED',
      'This "node_modules" folder was created without the --shamefully-hoist option.'
      + ' You must remove that option, or else "pnpm install --force" to recreate the "node_modules" folder.',
    )
  }
  if (opts.forceIndependentLeaves && Boolean(modules.independentLeaves) !== opts.independentLeaves) {
    if (opts.force) {
      // TODO: remove the node_modules in the lockfile directory
      await Promise.all(importers.map(purgeModulesDirsOfImporter))
      return
    }
    if (modules.independentLeaves) {
      throw new PnpmError(
        'INDEPENDENT_LEAVES_WANTED',
        'This "node_modules" folder was created using the --independent-leaves option.'
        + ' You must add that option, or else run "pnpm install --force" to recreate the "node_modules" folder.',
      )
    }
    throw new PnpmError(
      'INDEPENDENT_LEAVES_NOT_WANTED',
      'This "node_modules" folder was created without the --independent-leaves option.'
      + ' You must remove that option, or else "pnpm install --force" to recreate the "node_modules" folder.',
    )
  }
  if (opts.forceHoistPattern && rootImporter) {
    try {
      if (!R.equals(opts.currentHoistPattern, (opts.hoistPattern || undefined))) {
        if (opts.currentHoistPattern) {
          throw new PnpmError(
            'HOISTING_WANTED',
            'This "node_modules" folder was created using the --hoist-pattern option.'
            + ' You must add this option, or else add the --force option to recreate the "node_modules" folder.',
          )
        }
        throw new PnpmError(
          'HOISTING_NOT_WANTED',
          'This "node_modules" folder was created without the --hoist-pattern option.'
          + ' You must remove that option, or else add the --force option to recreate the "node_modules" folder.',
        )
      }
    } catch (err) {
      if (!opts.force) throw err
      await purgeModulesDirsOfImporter(rootImporter)
    }
  }
  await Promise.all(importers.map(async (importer) => {
    try {
      checkCompatibility(modules, {
        modulesDir: importer.modulesDir,
        storeDir: opts.storeDir,
        virtualStoreDir: opts.virtualStoreDir,
      })
      if (opts.lockfileDir !== importer.rootDir && opts.include && modules.included) {
        for (const depsField of DEPENDENCIES_FIELDS) {
          if (opts.include[depsField] !== modules.included[depsField]) {
            throw new PnpmError('INCLUDED_DEPS_CONFLICT',
              `node_modules (at "${opts.lockfileDir}") was installed with ${stringifyIncludedDeps(modules.included)}. ` +
              `Current install wants ${stringifyIncludedDeps(opts.include)}.`,
            )
          }
        }
      }
    } catch (err) {
      if (!opts.force) throw err
      await purgeModulesDirsOfImporter(importer)
    }
  }))
}

async function purgeModulesDirsOfImporter (
  importer: {
    modulesDir: string,
    rootDir: string,
  }
) {
  logger.info({
    message: `Recreating ${importer.modulesDir}`,
    prefix: importer.rootDir,
  })
  try {
    await rimraf(importer.modulesDir)
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
  }
}

function stringifyIncludedDeps (included: IncludedDependencies) {
  return DEPENDENCIES_FIELDS.filter((depsField) => included[depsField]).join(', ')
}

export interface PnpmSingleContext {
  currentLockfile: Lockfile,
  existsCurrentLockfile: boolean,
  existsWantedLockfile: boolean,
  extraBinPaths: string[],
  hoistedAliases: {[depPath: string]: string[]},
  hoistedModulesDir: string,
  hoistPattern: string[] | undefined,
  manifest: ImporterManifest,
  modulesDir: string,
  importerId: string,
  prefix: string,
  include: IncludedDependencies,
  independentLeaves: boolean,
  modulesFile: Modules | null,
  pendingBuilds: string[],
  registries: Registries,
  rootModulesDir: string,
  lockfileDir: string,
  virtualStoreDir: string,
  shamefullyHoist: boolean,
  skipped: Set<string>,
  storeDir: string,
  wantedLockfile: Lockfile,
}

export async function getContextForSingleImporter (
  manifest: ImporterManifest,
  opts: {
    force: boolean,
    forceSharedLockfile: boolean,
    extraBinPaths: string[],
    lockfileDir: string,
    hooks?: {
      readPackage?: ReadPackageHook,
    },
    include?: IncludedDependencies,
    dir: string,
    registries: Registries,
    storeDir: string,
    useLockfile: boolean,
    virtualStoreDir?: string,

    hoistPattern?: string[] | undefined,
    forceHoistPattern?: boolean,

    shamefullyHoist?: boolean,
    forceShamefullyHoist?: boolean,

    independentLeaves?: boolean,
    forceIndependentLeaves?: boolean,
  },
): Promise<PnpmSingleContext> {
  const {
    currentHoistPattern,
    hoist,
    hoistedAliases,
    importers,
    include,
    independentLeaves,
    modules,
    pendingBuilds,
    registries,
    shamefullyHoist,
    skipped,
    rootModulesDir,
  } = await readImportersContext(
    [
      {
        rootDir: opts.dir,
      },
    ],
    opts.lockfileDir,
  )

  const storeDir = opts.storeDir

  const importer = importers[0]
  const modulesDir = importer.modulesDir
  const importerId = importer.id
  const virtualStoreDir = pathAbsolute(opts.virtualStoreDir ?? 'node_modules/.pnpm', opts.lockfileDir)

  if (modules) {
    await validateNodeModules(modules, importers, {
      currentHoistPattern,
      force: opts.force,
      include: opts.include,
      lockfileDir: opts.lockfileDir,
      storeDir: opts.storeDir,
      virtualStoreDir,

      forceHoistPattern: opts.forceHoistPattern,
      hoistPattern: opts.hoistPattern,

      forceIndependentLeaves: opts.forceIndependentLeaves,
      independentLeaves: opts.independentLeaves,

      forceShamefullyHoist: opts.forceShamefullyHoist,
      shamefullyHoist: opts.shamefullyHoist,
    })
  }

  await fs.mkdir(storeDir, { recursive: true })
  const extraBinPaths = [
    ...opts.extraBinPaths || []
  ]
  const sHoist = Boolean(typeof shamefullyHoist === 'undefined' ? opts.shamefullyHoist : shamefullyHoist)
  if (opts.hoistPattern && !sHoist) {
    extraBinPaths.unshift(path.join(virtualStoreDir, 'node_modules/.bin'))
  }
  const hoistedModulesDir = sHoist
    ? rootModulesDir : path.join(virtualStoreDir, 'node_modules')
  const ctx: PnpmSingleContext = {
    extraBinPaths,
    hoistedAliases,
    hoistedModulesDir,
    hoistPattern: typeof hoist === 'boolean' ? currentHoistPattern : opts.hoistPattern,
    importerId,
    include: opts.include || include,
    independentLeaves: Boolean(typeof independentLeaves === 'undefined' ? opts.independentLeaves : independentLeaves),
    lockfileDir: opts.lockfileDir,
    manifest: opts.hooks?.readPackage?.(manifest) ?? manifest,
    modulesDir,
    modulesFile: modules,
    pendingBuilds,
    prefix: opts.dir,
    registries: {
      ...opts.registries,
      ...registries,
    },
    rootModulesDir,
    shamefullyHoist: sHoist,
    skipped,
    storeDir,
    virtualStoreDir,
    ...await readLockfileFile({
      force: opts.force,
      forceSharedLockfile: opts.forceSharedLockfile,
      importers: [{ id: importerId, rootDir: opts.dir }],
      lockfileDir: opts.lockfileDir,
      registry: opts.registries.default,
      useLockfile: opts.useLockfile,
      virtualStoreDir,
    }),
  }
  packageManifestLogger.debug({
    initial: manifest,
    prefix: opts.dir,
  })

  return ctx
}
