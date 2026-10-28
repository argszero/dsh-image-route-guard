# @argszero/dsh-image-route-guard

Keep an image block off a `deepseek-harness` **route** that cannot carry one, so a
single pasted or read image cannot make a session permanently unusable.

**What this does, in one sentence.** It removes the image block from the request
before it is dispatched, for the routes you name. It does **not** teach the
provider path to degrade images — that fix belongs in the condition described
below, and until it lands there this is the deployment-side narrowing.

## The failure

`LlmRuntime` assembles every outgoing request at one point, and it projects image
blocks into text exactly once — `packages/llm/llm/src/index.ts:1105-1109`:

```ts
if (modelInfo.inputModalities !== undefined
  && !modelInfo.inputModalities.includes('image')
  && projectedMessages.some(message => contentHasImage(message.content))) {
  projectedMessages = projectImagesForTextModel(projectedMessages)
}
```

That condition reads the **model's declared modality** and nothing else. It never
asks whether the **route** — the provider plus the protocol it is configured
with — has any legal wire shape for an image block. The primitives for degrading
an image already exist and are exported (`textOnlyImageText` at
`packages/llm/llm/src/content.ts:76`, `projectImagesForTextModel` at
`packages/llm/llm/src/content.ts:353`); this call site is simply the wrong
predicate.

So a model that truthfully declares `['text', 'image']`, served over a protocol
that cannot carry the block, dispatches it untouched:
`packages/llm/llm-pi-ai/src/context.ts` `toPiContextWithImages` converts it and
sends it.

Reported as discussion #11311. A vision model on a pi-ai `openai-responses`
route produced a `read_image` tool result carrying one local WebP image. The
block went out, and the gateway answered:

```
400 {"error":{"message":"Invalid JSON data: Failed to deserialize the JSON body
into the target type: input: data did not match any variant of untagged enum
ResponseInput ...","code":"json_parse_error"}}
```

Because that block lives in the **durable session record**, every later request
replayed it — including pure-text turns — so the session failed permanently with
no way back. The reporter's own gateway measurements are the useful part: on that
provider `/v1/responses` answered 500 even for pure text and marked image parts
`type:'unknown'`, while `/v1/chat/completions` accepted the same image twice
(URL and base64).

## What this plugin does

Mounted on the LLM runtime, it projects image blocks to the harness's own text
placeholder **before dispatch**, on the routes you declare image-incapable.
`projectImagesForTextModel` is used unchanged, so the placeholder is byte-for-byte
the string core emits for a text-only model:

```
[image omitted because this model accepts text only; attachment sha256:3f3f3f3f]
```

It walks the whole request, so an image inside a **tool result** is projected the
same way as one the user pasted — that is the reported shape.

It never touches `inputModalities`. If the same model is also served by a route
that *can* carry images, that route keeps sending them.

## Install

```sh
dsh plugin add github:argszero/dsh-image-route-guard#v0.1.0
```

Then name the routes that cannot carry an image block:

```yaml
- id: image-route-guard
  config:
    routes:
      - provider: agnes
        model: agnes-3.0-flash   # omit to cover every model on that provider
```

With no `routes`, the mount installs no wrapper at all and every request is
dispatched with the caller's own options object.

## Configuration

| key | default | meaning |
|---|---|---|
| `routes[].provider` | — (required) | route id exactly as registered |
| `routes[].model` | omitted | exact model id; omit to cover the whole provider |
| `warnLimit` | `5` | diagnostics per mount; `0` silences them |

## Boundaries

- **It acts only on routes you name.** It cannot detect which protocols carry
  images, and it will not guess: a route you forget is dispatched exactly as
  before.
- **It is not the core fix.** The predicate above should consult the route's own
  protocol capability; when it does, this mount becomes unnecessary.
- **A malformed rule fails at mount**, not silently at request time — the config
  schema is the gate.
- **Nothing else changes.** A call with no image, a route you did not name, or an
  unreadable request is dispatched by identity, not by a copy, with no diagnostic.

## Verification

Measured on `@deepseek-ai/dsh-llm@0.2.1-rc.3` with `@deepseek-ai/cordis@4.0.5`
(newer than the rc.2 in the report). Suite: 17 arms, 17 passing — behaviour arms
against a real `LlmRuntime` and a recording adapter, plus packaging arms.

The runtime imports nothing but `@deepseek-ai/schemastery`. That is not stylistic:
a profile carries the plugin, not the harness's own dependency tree, so importing
`@deepseek-ai/dsh-llm` made `dsh plugin add` return 0 and the *installed* copy
throw `ERR_MODULE_NOT_FOUND`. The two primitives this needs are a few lines each,
copied, and `test/` pins them byte-for-byte against the runtime's own exports.

Every line number above belongs to the upstream tree at `f3803c9697`
(`dsh-v0.2.2-alpha.2`); line numbers for this plugin's own files belong to its
tag `v0.1.0` and are not quoted here.

## License

MIT
