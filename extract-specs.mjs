// 工具参数/输出 Schema 的唯一来源（L7）：方言 spec 写在这里，用宿主真实 defineTool 编译，
// 产物写入 schemas.generated.js（插件本体零外部导入，只 import 该生成文件）。
//
//   node extract-specs.mjs --write   重新生成 schemas.generated.js
//   node extract-specs.mjs --check   校验生成文件与 spec 一致（不一致退出码 1）
//
// DSH_APP_DIR 覆盖宿主安装目录（默认 /Applications/DSH NEXT.app/Contents/Resources/app）。
import { createRequire } from 'node:module';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = process.env.DSH_APP_DIR || '/Applications/DSH NEXT.app/Contents/Resources/app';
const OUT = path.join(HERE, 'schemas.generated.js');
const req = createRequire(path.join(APP, 'node_modules/@deepseek-ai/dsh-tools/package.json'));
const { defineTool } = req('@deepseek-ai/dsh-tools');

const str = (description, extra = {}) => ({ type: 'string', ...(description ? { description } : {}), ...extra });
const reqd = (spec) => ({ ...spec, required: true });

const CONFLICT_ITEM = {
  type: 'object',
  additionalProperties: false,
  properties: {
    path: reqd(str()),
    ownerSessionId: reqd(str()),
    ownerLabel: reqd(str()),
    ownerOrigin: reqd(str()),
    expiresAt: reqd({ type: 'integer' }),
    note: reqd(str())
  }
};

const specs = {
  CLAIM_FILES: {
    parameters: {
      paths: reqd({
        type: 'array',
        description:
          'File paths you intend to modify (at most 50). Workspace-relative paths resolve against this session cwd; absolute and ~/ paths are kept.',
        items: { type: 'string' }
      }),
      ttl_seconds: { type: 'number', description: 'Claim lifetime in seconds; default 1800, clamped to [30, 86400].' },
      note: str('Short intent note shown to a conflicting session, e.g. "refactoring exports".'),
      cwd: str('Optional explicit absolute workspace root used to resolve relative paths; defaults to the calling session cwd.')
    },
    output: {
      ok: reqd({ type: 'boolean' }),
      sessionId: reqd(str()),
      registered: reqd({ type: 'boolean' }),
      expiresAt: reqd({ type: 'integer' }),
      conflicts: reqd({ type: 'array', items: CONFLICT_ITEM }),
      hint: reqd(str())
    }
  },
  RELEASE_FILES: {
    parameters: {
      paths: {
        type: 'array',
        description:
          'Specific paths to release (absolute or relative to this session cwd). Omit to release everything claimed by this session.',
        items: { type: 'string' }
      }
    },
    output: {
      ok: reqd({ type: 'boolean' }),
      sessionId: reqd(str()),
      released: reqd({ type: 'integer' }),
      hint: reqd(str())
    }
  },
  SEND_TO_SESSION: {
    parameters: {
      target: reqd(
        str('Target session id (exact, or a unique id prefix of at least 4 characters). On failure the tool lists reachable live sessions.')
      ),
      content: reqd(str('Message body for the target session. Be concrete: what you need, which files, and what you propose.')),
      mode: str(
        "'queue' (default) = appended as the target's next input, waiting for its current turn to end; 'steer' = inserted into the target's current step when it is running. Either mode starts a turn when the target is idle.",
        { enum: ['queue', 'steer'] }
      ),
      topic: str('Optional short topic label, e.g. "claim conflict on src/x.ts".')
    },
    output: {
      ok: reqd({ type: 'boolean' }),
      target: reqd(str()),
      mode: reqd(str()),
      delivered: reqd({ type: 'boolean' }),
      detail: reqd(str())
    }
  },
  NEGOTIATE: {
    parameters: {
      action: reqd(
        str(
          'offer/counter = propose resolution terms; accept = accept the pending offer of the peer; decline = refuse to negotiate; escalate = ask for human arbitration; status = read-only view of your open negotiations.',
          { enum: ['offer', 'counter', 'accept', 'decline', 'escalate', 'status'] }
        )
      ),
      path: reqd(str('Contested file path (absolute or workspace-relative to this session cwd).')),
      corr: str('Negotiation id from a [[DSH session-messenger · negotiate]] message; required when several negotiations are open for the same path.'),
      terms: {
        type: 'object',
        additionalProperties: false,
        description:
          'Resolution terms. Only the current claim holder may offer release-now / release-at; the writer may offer wait-until.',
        properties: {
          action: reqd(
            str(
              'release-now = holder frees the claim immediately; release-at = holder frees it at terms.at (ISO-8601); wait-until = writer commits to wait until terms.at and is reminded then.',
              { enum: ['release-now', 'release-at', 'wait-until'] }
            )
          ),
          at: str('ISO-8601 timestamp (required for release-at / wait-until, within 60 minutes).')
        }
      },
      message: str('Optional free-text note delivered to the peer with this intent.')
    },
    output: {
      ok: reqd({ type: 'boolean' }),
      negId: reqd(str()),
      path: reqd(str()),
      state: reqd(str()),
      rounds: reqd({ type: 'integer' }),
      deadline: reqd({ type: 'integer' }),
      released: reqd({ type: 'boolean' }),
      detail: reqd(str())
    }
  }
};

function render() {
  const lines = [
    '// GENERATED by extract-specs.mjs from the host defineTool compiler. Do not edit by hand.',
    '// Regenerate: node extract-specs.mjs --write   Verify: node extract-specs.mjs --check',
    ''
  ];
  for (const [name, spec] of Object.entries(specs)) {
    const compiled = defineTool({
      name: name.toLowerCase(),
      description: 'x',
      parameters: spec.parameters,
      output: { schema: { type: 'object', additionalProperties: false, properties: spec.output }, render: () => [] },
      execute: async () => ({})
    });
    lines.push(`export const ${name}_PARAMETERS = ${JSON.stringify(compiled.parameters, null, 2)};`, '');
    lines.push(`export const ${name}_OUTPUT = ${JSON.stringify(compiled.output.schema, null, 2)};`, '');
  }
  return lines.join('\n');
}

const mode = process.argv[2] || '--check';
const generated = render();
if (mode === '--write') {
  await fs.writeFile(OUT, generated, 'utf8');
  console.log(`wrote ${OUT}`);
} else {
  const current = await fs.readFile(OUT, 'utf8').catch(() => '');
  if (current !== generated) {
    console.log('schemas.generated.js is STALE — run: node extract-specs.mjs --write');
    process.exit(1);
  }
  console.log('schemas.generated.js is up to date');
}
