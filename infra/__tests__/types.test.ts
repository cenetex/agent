import {
  generateTaskId,
  parseRepoSlug,
  createRepoSlug,
  createArtifactPrefix,
  createArtifactKeys,
  createInitialTaskMetadata,
  createCreditBalancePath,
  createCreditLedgerPath,
  createEscalationConfigPath,
  createEscalationQueuePath,
  getModelCost,
  createGitHubAppJWT,
} from '../lib/types';

describe('types utilities', () => {
  describe('generateTaskId', () => {
    it('should generate a unique task ID with correct format', () => {
      const taskId = generateTaskId();
      expect(taskId).toMatch(/^task_[a-z0-9]+_[a-z0-9]{6}$/);
    });

    it('should generate different task IDs on each call', () => {
      const id1 = generateTaskId();
      const id2 = generateTaskId();
      expect(id1).not.toEqual(id2);
    });
  });

  describe('parseRepoSlug', () => {
    it('should parse valid repo slug into owner and name', () => {
      const result = parseRepoSlug('octocat/Hello-World');
      expect(result.owner).toBe('octocat');
      expect(result.name).toBe('Hello-World');
    });

    it('should throw on invalid repo slug format', () => {
      expect(() => parseRepoSlug('no-slash')).toThrow('Invalid repository slug');
      expect(() => parseRepoSlug('/no-owner')).toThrow('Invalid repository slug');
      expect(() => parseRepoSlug('no-name/')).toThrow('Invalid repository slug');
    });
  });

  describe('createRepoSlug', () => {
    it('should create repo slug from owner and name', () => {
      const slug = createRepoSlug('octocat', 'Hello-World');
      expect(slug).toBe('octocat/Hello-World');
    });
  });

  describe('createArtifactPrefix', () => {
    it('should create predictable artifact prefix', () => {
      const prefix = createArtifactPrefix('octocat/repo', 'task_abc123');
      expect(prefix).toBe('tasks/octocat/repo/task_abc123');
    });
  });

  describe('createArtifactKeys', () => {
    it('should create standardized task artifact keys', () => {
      const keys = createArtifactKeys('tasks/octocat/repo/task_abc123');

      expect(keys).toEqual({
        metadata: 'tasks/octocat/repo/task_abc123/metadata.json',
        log: 'tasks/octocat/repo/task_abc123/agent.log',
        summary: 'tasks/octocat/repo/task_abc123/summary.md',
        manifest: 'tasks/octocat/repo/task_abc123/manifest.json',
      });
    });
  });

  describe('createInitialTaskMetadata', () => {
    it('should preserve immutable task payload fields', () => {
      const metadata = createInitialTaskMetadata(
        {
          task_id: 'task_abc123_def456',
          repo_slug: 'octocat/repo',
          requested_ref: 'main',
          resolved_commit_sha: 'abc123',
          task_mode: 'issue',
          created_at: '2026-05-14T00:00:00Z',
          issue_metadata: {
            number: 42,
            title: 'Fix issue',
            body: 'Details',
            labels: ['agent'],
            author: 'octocat',
          },
        },
        'arn:aws:ecs:task/test'
      );

      expect(metadata).toMatchObject({
        task_id: 'task_abc123_def456',
        repo_slug: 'octocat/repo',
        issue_number: 42,
        task_mode: 'issue',
        status: 'requested',
        requested_ref: 'main',
        resolved_commit_sha: 'abc123',
        task_arn: 'arn:aws:ecs:task/test',
        artifact_prefix: 'tasks/octocat/repo/task_abc123_def456',
        created_at: '2026-05-14T00:00:00Z',
      });
    });
  });

  describe('credit helpers', () => {
    it('should map known model families to credit costs', () => {
      expect(getModelCost('anthropic/claude-haiku-4-5')).toBe(4);
      expect(getModelCost('anthropic/claude-sonnet-4-6')).toBe(12);
      expect(getModelCost('anthropic/claude-opus-4-6')).toBe(20);
      expect(getModelCost('unknown-model')).toBe(12);
    });

    it('should create stable credit storage paths', () => {
      const date = new Date('2026-05-14T10:00:00Z');

      expect(createCreditBalancePath('octocat/repo')).toBe('credits/octocat/repo/balance.json');
      expect(createCreditLedgerPath('octocat/repo', date)).toBe(
        'credits/octocat/repo/ledger/2026/05/transactions.jsonl'
      );
    });
  });

  describe('escalation path helpers', () => {
    it('should create stable escalation storage paths', () => {
      expect(createEscalationQueuePath('octocat/repo')).toBe('escalations/octocat/repo/queue.json');
      expect(createEscalationConfigPath('octocat/repo')).toBe('escalations/octocat/repo/config.json');
    });
  });

  describe('createGitHubAppJWT', () => {
    it('should create a valid JWT structure', () => {
      const testPrivateKey = `-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEA2a2rwplBJpBiZ2Q3C3sn8RxcMlN0U7TYrGU9Wp4aYEoqmJDB
hNiRNxP5YOxpnGDnMtMLz/dP0lE7jDHW38x/YZvn+3l2v/EH6kTtjRE9VHfX0R/w
7SvU6c4r9LQaIlZgXGD+KQzMKc0Rrj5OLIWCe/eo6GFCFQ/g6bRKqKFQ+L6LKjJ8
sVvv0n8z7DpJv0uNqZKrNvCZjPLBROTg9QW3QHWvXU3oi5uw0qWKVgqDPCHqVD65
cLB0LzJH2Y9v8mUxVQhPMp6n7G1eJvBNpVmF0FO/LZwGd8r4KvKpEW8L1YiE3LLw
m8qKnKtLfv0KWLYh8KHPmVJXI9HvNz3TbNBmswIDAQABAoIBAH0CgvA7XcUxGEYo
YqpZx7WYamFWVLvIKJlnvQaJKgDjyOeJGdVqPQ/LKQQ3a7aT8B7vX/KFBZsG3dIS
P6hU0aCCqKN8bfmLzGaswNsOSPyqgLlCCEULrlZmDWYNXk3OqNKb2kLpQf8P6Rj7
EBGKpFvLVDbjbAIWsOQu7BXe4J2L52bzKFLfUHxGH3qhYPaX7S3uLMfLlhGH3vY0
F7yYQrb8x1LPJ7dH4ij+KGykQw3LQ4C7T1zGd4L7Sg4G4fxIcYzhVxTvGZ4qOmXq
/C7Yc6/eZnVPiXLxMEf/qxyJUqYJI8B3wNb8LqcCWvXRJmXM1BzfKJL/HHJ9w/9s
eP3KZgECgYEA7uFBJvyBJOVwrJ8n9tB/mJPVrVPc2L6fSZPvGlFJDG5KoK3H8hJx
YnIIJ0YQPf1k+fI1OOzKQiW4WLzPEEKuVKGIm7v8yG0nN8LLxTBzLDCLQJlWBJUE
aGfqc1VYgmXVNpYbJDVppqQRgvR7qC+DgJ1gK8klPhqzBpLx3OFqpvkCgYEA6HVW
LhMJvCbSrb7Ztj8s7+JPPf+qZCQVBjLsNfPpLKjYNgJT4FQ3JCJ3L0YKnLfGJTkT
+aVKiZKiKTcLsM7C7oBq8BvD6LQvJp+3x/PTHLi8OqQDj1BYD7I9S7OqeD5HChRf
Yf5BhhsYHsOTK3MjXwMYECnI0sYEZPQKC4EoXwECgYEAxL1IvEshUnvvTIFM4U1B
5a5qZ3D9OtEYwpFGvqkKKjlVD5fEeGxsF8X3yTUwqGhW17GJGmDbmNw7u6lNfU8/
RkJaQP4cJYuI6QwRPLr1k5hzR9mFfXzF6mIdGx+DiEW3sSRIqFmfSR95xmB0rSJX
ib8PQxkqI8bqqCqP7LZqE6kCgYBUDFWwKnzP3uLHJlHfJ3Z4khz5cXuQqFQLfFqO
2aPaF/bNptEKU5wVNcKJoUXRGVMZEpVYLgNB1OvfSZVkEhj5Wdo3iZLU8hIW3Gqt
l8eAhCE6b5SIwVzYXLUoJExzCrHjGZjSLKSwNH2JfMTW8TtLQEXcLkfLdXBJ2xtA
PL0xAQKBgA3qD2phf00QWGJSVxTQeknJI5Bz7v3VJJZzDLQKCQLYjVvT3sXEj0BK
iZOu7YQJV8VrXUFHWLF9OVYX6BLW5rcJcPKjDVjEXqDdJqDaElbqNmDPE7BXNqB4
l0FIH8sYFVqyI8/0y3WK+4hh1/8C9c9MFnWLYvCnVJPnSuNzxWEh
-----END RSA PRIVATE KEY-----`;

      const jwt = createGitHubAppJWT('123456', testPrivateKey);
      const parts = jwt.split('.');

      expect(parts.length).toBe(3);
      expect(parts[0]).toBeTruthy(); // header
      expect(parts[1]).toBeTruthy(); // payload
      expect(parts[2]).toBeTruthy(); // signature
    });
  });
});
