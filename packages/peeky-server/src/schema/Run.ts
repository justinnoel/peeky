import { relative } from 'path'
import { fileURLToPath } from 'url'
import { performance } from 'perf_hooks'
import { arg, extendType, idArg, inputObjectType, nonNull, objectType } from 'nexus'
import shortid from 'shortid'
import { setupRunner, getStats, EventType } from '@peeky/runner'
import nameGenerator from 'project-name-generator'
import randomEmoji from 'random-emoji'
import objectInspect from 'object-inspect'
import type { Context } from '../context'
import { Status, StatusEnum } from './Status.js'
import { updateTestFile, testFiles } from './TestFile.js'
import { clearTestSuites, createTestSuite, updateTestSuite, testSuites } from './TestSuite.js'
import { updateTest } from './Test.js'
import { RunTestFileData, updateRunTestFile } from './RunTestFile.js'
import { getErrorPosition, getSrcFile, formatRunTestFileErrorMessage } from '../util.js'
import { settings } from './Settings.js'
import { mightRunOnChangedFiles } from '../watch.js'

const __filename = fileURLToPath(import.meta.url)

export const Run = objectType({
  name: 'Run',
  sourceType: {
    module: getSrcFile(__filename),
    export: 'RunData',
  },
  definition (t) {
    t.nonNull.id('id')
    t.nonNull.string('title')
    t.nonNull.string('emoji')
    t.nonNull.float('progress')
    t.nonNull.field('status', {
      type: Status,
    })
    t.float('duration')
  },
})

export const RunQuery = extendType({
  type: 'Query',
  definition (t) {
    t.nonNull.list.field('runs', {
      type: nonNull(Run),
      resolve: () => runs,
    })

    t.field('run', {
      type: Run,
      args: {
        id: nonNull(idArg()),
      },
      resolve: (_, { id }) => runs.find(r => r.id === getRunId(id)),
    })

    t.field('lastRun', {
      type: Run,
      resolve: () => runs[runs.length - 1],
    })
  },
})

export const RunMutation = extendType({
  type: 'Mutation',
  definition (t) {
    t.nonNull.field('startRun', {
      type: Run,
      args: {
        input: arg({
          type: nonNull(StartRunInput),
        }),
      },
      resolve: async (_, { input }, ctx) => {
        const run = await createRun(ctx, {
          testFileIds: input.testFileIds,
        })
        startRun(ctx, run.id)
        return run
      },
    })

    t.nonNull.field('clearRun', {
      type: Run,
      args: {
        input: arg({
          type: nonNull(ClearRunInput),
        }),
      },
      resolve: async (_, { input }, ctx) => clearRun(ctx, input.id),
    })

    t.nonNull.field('clearRuns', {
      type: 'Boolean',
      resolve: async (_, args, ctx) => clearRuns(ctx),
    })
  },
})

export const StartRunInput = inputObjectType({
  name: 'StartRunInput',
  definition (t) {
    t.list.nonNull.string('testFileIds')
  },
})

export const ClearRunInput = inputObjectType({
  name: 'ClearRunInput',
  definition (t) {
    t.nonNull.id('id')
  },
})

const RunAdded = 'run-added'

interface RunAddedPayload {
  run: RunData
}

const RunUpdated = 'run-updated'

interface RunUpdatedPayload {
  run: RunData
}

const RunRemoved = 'run-removed'

interface RunRemovedPayload {
  run: RunData
}

export const RunSubscription = extendType({
  type: 'Subscription',

  definition (t) {
    t.field('runAdded', {
      type: nonNull(Run),
      subscribe: (_, args, ctx) => ctx.pubsub.asyncIterator(RunAdded),
      resolve: (payload: RunAddedPayload) => payload.run,
    })

    t.field('runUpdated', {
      type: nonNull(Run),
      subscribe: (_, args, ctx) => ctx.pubsub.asyncIterator(RunUpdated),
      resolve: (payload: RunUpdatedPayload) => payload.run,
    })

    t.field('runRemoved', {
      type: nonNull(Run),
      subscribe: (_, args, ctx) => ctx.pubsub.asyncIterator(RunRemoved),
      resolve: (payload: RunRemovedPayload) => payload.run,
    })
  },
})

export interface RunData {
  id: string
  title: string
  emoji: string
  progress: number
  status: StatusEnum
  duration: number
  runTestFiles: RunTestFileData[]
}

export let runs: RunData[] = []

export interface CreateRunOptions {
  testFileIds: string[]
}

export async function createRun (ctx: Context, options: CreateRunOptions) {
  const runId = shortid()

  const testFilesRaw = options.testFileIds ? testFiles.filter(f => options.testFileIds.includes(f.id)) : [...testFiles]
  const runTestFiles: RunTestFileData[] = testFilesRaw.map(f => ({
    id: shortid(),
    slug: f.relativePath.replace(/([\\/.])/g, '-'),
    runId,
    testFile: f,
    status: 'in_progress',
    duration: null,
    buildDuration: null,
    error: null,
  }))

  const run: RunData = {
    id: runId,
    title: nameGenerator().dashed,
    emoji: randomEmoji.random({ count: 1 })[0].character,
    progress: 0,
    status: 'in_progress',
    duration: null,
    runTestFiles: runTestFiles,
  }
  runs.push(run)

  ctx.pubsub.publish(RunAdded, {
    run,
  } as RunAddedPayload)

  return run
}

export async function getRun (ctx: Context, id: string) {
  const run = (id === 'last-run') ? runs[runs.length - 1] : runs.find(r => r.id === id)
  if (run) {
    return run
  } else {
    throw new Error(`Run ${id} not found`)
  }
}

export function getRunId (id: string) {
  return ((id === 'last-run') ? runs[runs.length - 1] : runs.find(r => r.id === id))?.id
}

export async function updateRun (ctx: Context, id: string, data: Partial<Omit<RunData, 'id'>>) {
  const run = await getRun(ctx, id)
  Object.assign(run, data)
  ctx.pubsub.publish(RunUpdated, {
    run,
  } as RunUpdatedPayload)
  return run
}

export async function startRun (ctx: Context, id: string) {
  const run = await getRun(ctx, id)

  await Promise.all(run.runTestFiles.map(async f => {
    updateTestFile(ctx, f.testFile.id, { status: 'in_progress' })
    updateRunTestFile(ctx, run.id, f.id, { status: 'in_progress' })
  }))

  const time = performance.now()
  const runner = await setupRunner({
    config: ctx.config,
    testFiles: ctx.reactiveFs,
  })
  runner.onEvent(async (eventType, payload) => {
    if (eventType === EventType.BUILD_COMPLETED) {
      const { testFilePath, duration } = payload
      const testFileId = relative(ctx.config.targetDirectory, testFilePath)
      const runTestFileId = run.runTestFiles.find(rf => rf.testFile.id === testFileId)?.id
      updateRunTestFile(ctx, run.id, runTestFileId, {
        buildDuration: duration,
      })
    } else if (eventType === EventType.SUITE_START) {
      const { suite } = payload
      const testFileId = relative(ctx.config.targetDirectory, suite.filePath)
      createTestSuite(ctx, {
        id: suite.id,
        runId: run.id,
        runTestFile: run.runTestFiles.find(rf => rf.testFile.id === testFileId),
        title: suite.title,
        tests: suite.tests,
      })
    } else if (eventType === EventType.SUITE_COMPLETED) {
      const { suite, duration } = payload
      const suiteData = testSuites.find(s => s.id === suite.id)
      updateTestSuite(ctx, suite.id, {
        status: !suiteData.tests.length ? 'skipped' : suite.testErrors + suite.otherErrors.length ? 'error' : 'success',
        duration,
      })
    } else if (eventType === EventType.TEST_START) {
      const { suite, test } = payload
      updateTest(ctx, suite.id, test.id, {
        status: 'in_progress',
      })
    } else if (eventType === EventType.TEST_SUCCESS) {
      const { suite, test, duration } = payload
      updateTest(ctx, suite.id, test.id, {
        status: 'success',
        duration,
      })
    } else if (eventType === EventType.TEST_ERROR) {
      const { suite, test, duration, error, stack, matcherResult } = payload
      const testFile = testSuites.find(s => s.id === suite.id).runTestFile.testFile
      const { line, col } = getErrorPosition(testFile.relativePath, stack)
      const lineSource = (await ctx.reactiveFs.files[testFile.relativePath].waitForContent).split('\n')[line - 1]
      updateTest(ctx, suite.id, test.id, {
        status: 'error',
        duration,
        error: {
          message: error.message,
          stack: stack,
          snippet: lineSource.trim(),
          line,
          col,
          expected: matcherResult?.expected ? stringifyJS(matcherResult.expected) : null,
          actual: matcherResult?.actual ? stringifyJS(matcherResult.actual) : null,
        },
      })
    }
  })

  try {
    let completed = 0

    const results = await Promise.all(run.runTestFiles.map(async f => {
      try {
        const result = await runner.runTestFile(f.testFile.relativePath)
        const stats = getStats([result])
        const status: StatusEnum = !stats.testCount ? 'skipped' : stats.errorTestCount > 0 ? 'error' : 'success'
        await updateTestFile(ctx, f.testFile.id, {
          status,
          duration: result.duration,
          modules: result.modules,
        })
        await updateRunTestFile(ctx, run.id, f.id, {
          status,
          duration: result.duration,
        })
        completed++
        await updateRun(ctx, run.id, {
          progress: completed / run.runTestFiles.length,
        })
        return result
      } catch (e) {
        e.message = formatRunTestFileErrorMessage(e, f)
        await updateTestFile(ctx, f.testFile.id, {
          status: 'error',
        })
        await updateRunTestFile(ctx, run.id, f.id, {
          status: 'error',
          error: {
            message: e.message,
          },
        })
        throw e
      }
    }))

    const stats = getStats(results)
    await updateRun(ctx, id, {
      status: stats.errorTestCount > 0 ? 'error' : 'success',
      duration: performance.now() - time,
    })

    if (settings.watch) {
      mightRunOnChangedFiles(ctx)
    }
  } catch (e) {
    await updateRun(ctx, run.id, {
      status: 'error',
    })
  }

  return run
}

export async function clearRun (ctx: Context, id: string) {
  const run = await getRun(ctx, id)
  if (run.status === 'in_progress') {
    throw new Error(`Run ${id} is in progress and can't be cleared`)
  }
  const index = runs.indexOf(run)
  if (index !== -1) {
    runs.splice(index, 1)
  }
  clearTestSuites(ctx, id)
  ctx.pubsub.publish(RunRemoved, {
    run,
  } as RunRemovedPayload)
  return run
}

export function clearRuns (ctx: Context) {
  clearTestSuites(ctx)
  runs = []
  return true
}

export function isRunning () {
  return runs[runs.length - 1]?.status === 'in_progress'
}

function stringifyJS (object: any) {
  return objectInspect(object, {
    depth: 32,
    indent: 2,
  })
}
