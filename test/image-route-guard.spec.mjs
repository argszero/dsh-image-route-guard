import { test } from 'node:test'
import assert from 'node:assert/strict'

import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter, createUserMessage, createToolResultMessage, textOnlyImageText } from '@deepseek-ai/dsh-llm'

import * as guard from '../lib/index.js'

const image = {
  attachmentId: 'sha256:' + '3f'.repeat(32),
  mediaType: 'image/webp',
  bytes: 33116,
  width: 512,
  height: 512,
  name: '010.webp',
}

const SCRIPT = [
  { type: 'text-delta', index: 0, text: 'hi' },
  { type: 'block-end', index: 0, block: { type: 'text', text: 'hi' } },
  { type: 'finish', reason: { kind: 'stop' } },
]

/** Records the options the adapter is actually asked to send, then plays a canned stream. */
class RecordingAdapter extends LlmAdapter {
  requests = []
  async resolveModel(provider, model) {
    return { provider, id: model, name: model, inputModalities: ['text', 'image'] }
  }
  async *stream(options) {
    this.requests.push(options)
    yield* SCRIPT
  }
}

async function collect(iterable) {
  const out = []
  for await (const chunk of iterable) out.push(chunk)
  return out
}

async function harness() {
  const ctx = new Context()
  const warnings = []
  await ctx.plugin(LlmRuntime)
  const adapter = new RecordingAdapter()
  ctx.llm.registerAdapter(['agnes', 'other'], adapter)
  // Capture diagnostics without depending on a logger plugin being mounted.
  // The stub carries the whole surface cordis itself uses on reload.
  const noop = () => {}
  Object.defineProperty(ctx, 'logger', {
    configurable: true,
    get: () => ({
      warn: (line) => warnings.push(line),
      error: noop, info: noop, debug: noop, success: noop, log: noop, trace: noop,
      level: 'info',
    }),
  })
  return { ctx, adapter, warnings }
}

function userWithImage() {
  return createUserMessage({ content: [{ type: 'image', attachment: image }], source: { kind: 'user' } })
}

/** The reporter's shape: the image arrives inside a read_image tool result. */
function toolResultWithImage() {
  return createToolResultMessage({
    callId: 'call-1',
    content: [
      { type: 'text', text: '<path>/tmp/010.webp</path>\nimage/webp image, 512x512 px' },
      { type: 'image', attachment: image },
    ],
  })
}

async function send(ctx, adapter, messages, provider = 'agnes', model = 'agnes-3.0-flash') {
  adapter.requests.length = 0
  const options = { provider, model, messages }
  await collect(ctx.llm.stream(options))
  return { sent: adapter.requests.at(-1), options }
}

const blocksOf = (sent) => sent.messages.flatMap((message) => message.content)

// ---------------------------------------------------------------- positives

test('a declared route stops putting the image block on the wire', async () => {
  const { ctx, adapter } = await harness()
  await ctx.plugin(guard, { routes: [{ provider: 'agnes', model: 'agnes-3.0-flash' }] })
  const { sent } = await send(ctx, adapter, [userWithImage()])
  assert.equal(blocksOf(sent).some((block) => block.type === 'image'), false)
  assert.deepEqual(blocksOf(sent).map((block) => block.type), ['text'])
})

test('the placeholder is core own textOnlyImageText, byte for byte', async () => {
  const { ctx, adapter } = await harness()
  await ctx.plugin(guard, { routes: [{ provider: 'agnes' }] })
  const { sent } = await send(ctx, adapter, [userWithImage()])
  const text = blocksOf(sent).find((block) => block.type === 'text')
  assert.equal(text.text, textOnlyImageText(image))
})

test('a tool result carrying the image is projected too (the reported shape)', async () => {
  const { ctx, adapter } = await harness()
  await ctx.plugin(guard, { routes: [{ provider: 'agnes' }] })
  const { sent } = await send(ctx, adapter, [userWithImage(), toolResultWithImage()])
  const result = sent.messages.at(-1)
  assert.equal(result.role, 'tool')
  assert.equal(result.content.some((block) => block.type === 'image'), false)
  // The text half of that tool result survives untouched.
  assert.ok(result.content.some((block) => block.type === 'text' && block.text.includes('<path>')))
})

test('omitting model covers every model on the provider', async () => {
  const { ctx, adapter } = await harness()
  await ctx.plugin(guard, { routes: [{ provider: 'agnes' }] })
  for (const model of ['agnes-3.0-flash', 'some-other-model']) {
    const { sent } = await send(ctx, adapter, [userWithImage()], 'agnes', model)
    assert.equal(blocksOf(sent).some((block) => block.type === 'image'), false, model)
  }
})

test('every image in the history is projected, not only the newest', async () => {
  const { ctx, adapter } = await harness()
  await ctx.plugin(guard, { routes: [{ provider: 'agnes' }] })
  const { sent } = await send(ctx, adapter, [userWithImage(), toolResultWithImage()])
  assert.equal(blocksOf(sent).some((block) => block.type === 'image'), false)
})

// ---------------------------------------------------------------- negatives

test('NEGATIVE: an undeclared provider keeps its image and its own options object', async () => {
  const { ctx, adapter } = await harness()
  await ctx.plugin(guard, { routes: [{ provider: 'agnes' }] })
  const { sent, options } = await send(ctx, adapter, [userWithImage()], 'other', 'm')
  assert.equal(blocksOf(sent).some((block) => block.type === 'image'), true)
  assert.equal(sent, options, 'an untouched call must be dispatched by identity, not a copy')
})

test('NEGATIVE: a route pinned to another model is left alone', async () => {
  const { ctx, adapter } = await harness()
  await ctx.plugin(guard, { routes: [{ provider: 'agnes', model: 'agnes-3.0-flash' }] })
  const { sent } = await send(ctx, adapter, [userWithImage()], 'agnes', 'agnes-3.0-pro')
  assert.equal(blocksOf(sent).some((block) => block.type === 'image'), true)
})

test('NEGATIVE: a declared route with no image is dispatched by identity (silent when healthy)', async () => {
  const { ctx, adapter, warnings } = await harness()
  await ctx.plugin(guard, { routes: [{ provider: 'agnes' }] })
  const plain = createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } })
  const { sent, options } = await send(ctx, adapter, [plain])
  assert.equal(sent, options)
  assert.deepEqual(warnings, [])
})

test('NEGATIVE: an empty config mounts inert and installs no wrapper', async () => {
  const { ctx, adapter } = await harness()
  const instance = ctx.llm[Symbol.for('cordis.original')] ?? ctx.llm
  const before = instance.stream
  await ctx.plugin(guard, {})
  assert.equal(instance.stream, before, 'inert mount must not shadow the runtime')
  const { sent } = await send(ctx, adapter, [userWithImage()])
  assert.equal(blocksOf(sent).some((block) => block.type === 'image'), true)
})

test('NEGATIVE: disposing the mount restores the runtime exactly', async () => {
  const { ctx, adapter } = await harness()
  const instance = ctx.llm[Symbol.for('cordis.original')] ?? ctx.llm
  const before = instance.stream
  const scope = await ctx.plugin(guard, { routes: [{ provider: 'agnes' }] })
  assert.notEqual(instance.stream, before)
  await scope.dispose()
  assert.equal(instance.stream, before, 'teardown must remove only our own property')
  const { sent } = await send(ctx, adapter, [userWithImage()])
  assert.equal(blocksOf(sent).some((block) => block.type === 'image'), true)
})

// ---------------------------------------------------------------- fail-open

test('a malformed route fails loudly at mount, before any request is seen', async () => {
  const { ctx } = await harness()
  // The schema is the gate: a bad rule is a mount-time error the operator sees,
  // never a silent no-op that looks configured.
  await assert.rejects(
    async () => { await ctx.plugin(guard, { routes: [{ nope: true }] }) },
    /provider missing required value/,
  )
})

test('FAIL-OPEN: apply itself is total, even when called with junk', async () => {
  const { ctx, adapter } = await harness()
  // Cordis validates first; this pins that a direct call cannot throw either.
  assert.doesNotThrow(() => guard.apply(ctx, { routes: [null, 42, { provider: '' }] }))
  const { sent, options } = await send(ctx, adapter, [userWithImage()])
  assert.equal(sent, options, 'no usable rule means dispatch by identity')
  assert.equal(blocksOf(sent).some((block) => block.type === 'image'), true)
})

test('FAIL-OPEN: a call the mount cannot read is dispatched untouched', async () => {
  const { ctx, adapter } = await harness()
  await ctx.plugin(guard, { routes: [{ provider: 'agnes' }] })
  adapter.requests.length = 0
  // messages is not an array: a reader that trusted it would throw.
  await collect(ctx.llm.stream({ provider: 'agnes', model: 'm', messages: undefined }))
  assert.equal(adapter.requests.length, 0, 'the runtime rejected it before dispatch')
})
