export function buildRepoToolSchemas() {
  const repoSchema = {
    type: 'object',
    properties: { repo_id: { type: 'string' } },
    required: ['repo_id'],
    additionalProperties: false,
  };
  return [
    { name: 'get_repo_capabilities', description: 'Return read/write mode, index capabilities, and limits for a registered repo.', inputSchema: repoSchema },
    {
      name: 'repo_manifest',
      description: 'Return the complete non-.ignore repo inventory with indexed/readable metadata.',
      inputSchema: {
        type: 'object',
        properties: { repo_id: { type: 'string' }, snapshot_id: { type: 'string' }, cursor: { type: 'string' }, page_size: { type: 'number' } },
        required: ['repo_id'],
        additionalProperties: false,
      },
    },
    {
      name: 'list_tree',
      description: 'List non-.ignore children under a repo-relative directory with stable pagination.',
      inputSchema: {
        type: 'object',
        properties: { repo_id: { type: 'string' }, path: { type: 'string', default: '.' }, depth: { type: 'number' }, cursor: { type: 'string' }, page_size: { type: 'number' }, snapshot_id: { type: 'string' } },
        required: ['repo_id'],
        additionalProperties: false,
      },
    },
    {
      name: 'search_text',
      description: 'Search allowed repo text using CodeGraph first and policy-consistent fallback when needed.',
      inputSchema: {
        type: 'object',
        properties: { repo_id: { type: 'string' }, query: { type: 'string' }, mode: { enum: ['literal', 'regex'] }, paths: { type: 'array', items: { type: 'string' } }, cursor: { type: 'string' }, snapshot_id: { type: 'string' }, max_results: { type: 'number' } },
        required: ['repo_id', 'query'],
        additionalProperties: false,
      },
    },
    {
      name: 'read_file',
      description: 'Read one allowed file by line or byte range with hash and continuation metadata.',
      inputSchema: {
        type: 'object',
        properties: { repo_id: { type: 'string' }, path: { type: 'string' }, line_range: { type: 'array' }, byte_range: { type: 'array' }, snapshot_id: { type: 'string' }, cursor: { type: 'string' } },
        required: ['repo_id', 'path'],
        additionalProperties: false,
      },
    },
    {
      name: 'read_files',
      description: 'Read a bounded batch of allowed files with per-item success or failure.',
      inputSchema: {
        type: 'object',
        properties: { repo_id: { type: 'string' }, requests: { type: 'array' }, snapshot_id: { type: 'string' }, byte_budget: { type: 'number' } },
        required: ['repo_id', 'requests'],
        additionalProperties: false,
      },
    },
    {
      name: 'stat_file',
      description: 'Return metadata for one allowed file, directory, or symlink.',
      inputSchema: {
        type: 'object',
        properties: { repo_id: { type: 'string' }, path: { type: 'string' }, snapshot_id: { type: 'string' } },
        required: ['repo_id', 'path'],
        additionalProperties: false,
      },
    },
    {
      name: 'write_file',
      description: 'Create or replace one repo-relative file in a read_write repo using revision preconditions and atomic same-directory rename.',
      inputSchema: {
        type: 'object',
        properties: {
          repo_id: { type: 'string' },
          path: { type: 'string' },
          content: { type: 'string' },
          encoding: { enum: ['utf-8', 'base64'] },
          expected_sha256: { type: 'string' },
          must_not_exist: { type: 'boolean' },
        },
        required: ['repo_id', 'path', 'content'],
        additionalProperties: false,
      },
    },
    {
      name: 'apply_patch',
      description: 'Apply structured text edits or a guarded unified diff to one existing repo-relative file using an expected_sha256 precondition.',
      inputSchema: {
        type: 'object',
        properties: {
          repo_id: { type: 'string' },
          path: { type: 'string' },
          expected_sha256: { type: 'string' },
          edits: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                old_text: { type: 'string' },
                new_text: { type: 'string' },
                occurrence: { type: 'number' },
              },
              required: ['old_text', 'new_text'],
              additionalProperties: false,
            },
          },
          unified_diff: { type: 'string' },
        },
        required: ['repo_id', 'path', 'expected_sha256'],
        additionalProperties: false,
      },
    },
    {
      name: 'move_path',
      description: 'Move one existing repo-relative file to a new repo-relative path using source hash and target-existence preconditions.',
      inputSchema: {
        type: 'object',
        properties: {
          repo_id: { type: 'string' },
          from_path: { type: 'string' },
          to_path: { type: 'string' },
          expected_sha256: { type: 'string' },
          must_not_exist: { type: 'boolean' },
        },
        required: ['repo_id', 'from_path', 'to_path', 'expected_sha256', 'must_not_exist'],
        additionalProperties: false,
      },
    },
    {
      name: 'delete_path',
      description: 'Delete one existing repo-relative regular file using an expected_sha256 precondition; directory and recursive deletes are disabled in v1.',
      inputSchema: {
        type: 'object',
        properties: {
          repo_id: { type: 'string' },
          path: { type: 'string' },
          expected_sha256: { type: 'string' },
          recursive: { type: 'boolean' },
        },
        required: ['repo_id', 'path', 'expected_sha256'],
        additionalProperties: false,
      },
    },
    {
      name: 'refresh_repo_index',
      description: 'Synchronize CodeGraph for a read_write repo after mutations and return the new index/snapshot state.',
      inputSchema: {
        type: 'object',
        properties: {
          repo_id: { type: 'string' },
          paths: { type: 'array', items: { type: 'string' } },
          mutation_id: { type: 'string' },
        },
        required: ['repo_id'],
        additionalProperties: false,
      },
    },
  ];
}
