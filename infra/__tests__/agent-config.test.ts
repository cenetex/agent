import {
  DEFAULT_DISPATCH_CONFIG,
  DEFAULT_MERGE_HOLD_CONFIG,
  parseAgentConfig,
} from '../lib/agent-config';

describe('agent config parsing', () => {
  it('parses model, dispatch, and merge hold settings', () => {
    const config = parseAgentConfig(`
model: anthropic/claude-opus-4-6
auto_dispatch: false
auto_dispatch_labels: ready, safe-to-run
wip_cap: 2
max_concurrent: 4
merge_hold_minutes: 90
merge_hold_minutes_infra: 240
`);

    expect(config).toEqual({
      model: 'anthropic/claude-opus-4-6',
      dispatch: {
        auto_dispatch: false,
        auto_dispatch_labels: ['ready', 'safe-to-run'],
        wip_cap: 2,
        max_concurrent: 4,
      },
      mergeHold: {
        merge_hold_minutes: 90,
        merge_hold_minutes_infra: 240,
      },
    });
  });

  it('uses defaults for missing or invalid values', () => {
    const config = parseAgentConfig(`
auto_dispatch: maybe
wip_cap: no
max_concurrent: -1
merge_hold_minutes: never
`);

    expect(config.model).toBeNull();
    expect(config.dispatch).toEqual(DEFAULT_DISPATCH_CONFIG);
    expect(config.mergeHold).toEqual(DEFAULT_MERGE_HOLD_CONFIG);
  });

  it('allows an empty dispatch label list', () => {
    const config = parseAgentConfig('auto_dispatch_labels:');

    expect(config.dispatch.auto_dispatch_labels).toEqual(DEFAULT_DISPATCH_CONFIG.auto_dispatch_labels);
  });
});
