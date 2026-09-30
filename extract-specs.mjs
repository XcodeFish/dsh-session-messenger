// 一次性工具：用宿主真实的 defineTool 把本插件四个工具的方言 spec 编译成最终 JSON Schema。
// 产物将硬编码进 index.js（插件本体零外部导入）。运行: node extract-specs.mjs
import { createRequire } from 'node:module';

const req = createRequire(
  '/Applications/DSH NEXT.app/Contents/Resources/app/node_modules/@deepseek-ai/dsh-tools/package.json'
);
const { defineTool } = req('@deepseek-ai/dsh-tools');

const CONFLICT_ITEM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    path: { type: 'string', required: true },
    ownerSessionId: { type: 'string', required: true },
    ownerLabel: { type: 'string', required: true },
    expiresAt: { type: 'integer', required: true },
    note: { type: 'string', required: true }
  }
};

const specs = {
  claim_files: {
    name: 'claim_files',
    description: 'x',
    parameters: {
      paths: {
        type: 'array',
        required: true,
        description:
          'File paths you intend to modify. Workspace-relative paths resolve against this session cwd; absolute paths are kept.',
        items: { type: 'string' }
      },
      ttl_seconds: {
        type: 'number',
        description: 'Claim lifetime in seconds; default 1800, clamped to [30, 86400].'
      },
      note: {
        type: 'string',
        description: 'Short intent note shown to a conflicting session, e.g. "refactoring exports".'
      },
      cwd: {
        type: 'string',
        description:
          'Optional explicit absolute workspace root used to resolve relative paths; defaults to the calling session cwd.'
      }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          sessionId: { type: 'string', required: true },
          registered: { type: 'boolean', required: true },
          expiresAt: { type: 'integer', required: true },
          conflicts: { type: 'array', required: true, items: CONFLICT_ITEM_SCHEMA },
          hint: { type: 'string', required: true }
        }
      },
      render: () => []
    },
    execute: async () => ({})
  },
  release_files: {
    name: 'release_files',
    description: 'x',
    parameters: {
      paths: {
        type: 'array',
        description:
          'Specific paths to release (absolute or relative to this session cwd). Omit to release everything claimed by this session.',
        items: { type: 'string' }
      }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          sessionId: { type: 'string', required: true },
          released: { type: 'integer', required: true },
          hint: { type: 'string', required: true }
        }
      },
      render: () => []
    },
    execute: async () => ({})
  },
  send_to_session: {
    name: 'send_to_session',
    description: 'x',
    parameters: {
      target: {
        type: 'string',
        required: true,
        description:
          'Target session id (exact, or a unique id prefix). On failure the tool lists live session candidates.'
      },
      content: {
        type: 'string',
        required: true,
        description:
          'Message body for the target session. Be concrete: what you need, which files, and what you propose.'
      },
      mode: {
        type: 'string',
        enum: ['queue', 'steer'],
        description:
          "'queue' (default) = next turn, safe; 'steer' = interject into the target's current step, only while it is running."
      },
      topic: {
        type: 'string',
        description: 'Optional short topic label, e.g. "claim conflict on src/x.ts".'
      }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          target: { type: 'string', required: true },
          mode: { type: 'string', required: true },
          delivered: { type: 'boolean', required: true },
          detail: { type: 'string', required: true }
        }
      },
      render: () => []
    },
    execute: async () => ({})
  },
  negotiate: {
    name: 'negotiate',
    description: 'x',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['offer', 'counter', 'accept', 'decline', 'escalate', 'status'],
        description:
          'offer/counter = propose resolution terms; accept = accept the pending offer of the peer; decline = refuse to negotiate; escalate = ask for human arbitration; status = read-only view of your open negotiations.'
      },
      path: {
        type: 'string',
        required: true,
        description: 'Contested file path (absolute or workspace-relative to this session cwd).'
      },
      corr: {
        type: 'string',
        description:
          'Negotiation id from a [[DSH session-messenger · negotiate]] message; use it when several negotiations are open for the same path.'
      },
      terms: {
        type: 'object',
        additionalProperties: false,
        description:
          'Resolution terms. Only the current claim holder may offer release-now / release-at; the writer may offer wait-until.',
        properties: {
          action: {
            type: 'string',
            required: true,
            enum: ['release-now', 'release-at', 'wait-until'],
            description:
              'release-now = holder frees the claim immediately; release-at = holder frees it at terms.at (ISO-8601); wait-until = writer commits to wait until terms.at and is reminded then.'
          },
          at: {
            type: 'string',
            description: 'ISO-8601 timestamp (required for release-at / wait-until, within 60 minutes).'
          }
        }
      },
      message: { type: 'string', description: 'Optional free-text note delivered to the peer with this intent.' }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          negId: { type: 'string', required: true },
          path: { type: 'string', required: true },
          state: { type: 'string', required: true },
          rounds: { type: 'integer', required: true },
          deadline: { type: 'integer', required: true },
          released: { type: 'boolean', required: true },
          detail: { type: 'string', required: true }
        }
      },
      render: () => []
    },
    execute: async () => ({})
  }
};

for (const [name, spec] of Object.entries(specs)) {
  const compiled = defineTool(spec);
  console.log(`\n===== ${name}.parameters =====`);
  console.log(JSON.stringify(compiled.parameters, null, 2));
  console.log(`===== ${name}.output.schema =====`);
  console.log(JSON.stringify(compiled.output.schema, null, 2));
}
