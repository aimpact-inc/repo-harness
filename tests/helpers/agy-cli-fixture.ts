/** `unavailable`: agy lists the model but refuses to select it, so its effort menu cannot be read. */
type AgyModel = string | { readonly id: string; readonly efforts: readonly string[] | 'unavailable' };
export type AgyCatalogFixture = readonly AgyModel[] | 'signed_out' | 'malformed' | 'timeout';

/**
 * Native CLI responses for OAR installation and ACP catalog queries, with optional quota responses.
 * With `release`, the catalog writes `<release>.held` and answers only after `release` exists, so a test can hold a catalog read open.
 */
export function agyCatalogScript(catalog: AgyCatalogFixture, version = '1.5.12', otherCommands = 'process.exit(93);', release?: string): string {
  return `
{
  const command = process.argv[2];
  if (command === '--help') { console.log('Usage of agy: --conversation'); process.exit(0); }
  if (command === '--version') { console.log(${JSON.stringify(version)}); process.exit(0); }
  if (command === 'acp') {
    const catalog = ${JSON.stringify(catalog)};
    const models = Array.isArray(catalog) ? catalog.map(item => typeof item === 'string' ? { id: item, efforts: [] } : item) : [];
    let model = models[0];
    let effort = model?.efforts[0];
    const configOptions = () => [
      { id: 'model', type: 'select', currentValue: model?.id, options: models.map(entry => ({ value: entry.id, name: entry.id })) },
      ...(effort === undefined ? [] : [{ id: 'thought_level', category: 'thought_level', type: 'select', currentValue: effort,
        options: model.efforts.map(value => ({ value, name: value })) }]),
    ];
    require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
      const { id, method, params } = JSON.parse(line);
      const reply = value => console.log(JSON.stringify({ jsonrpc: '2.0', id, ...value }));
      if (method === 'initialize') reply({ result: { protocolVersion: 1, agentCapabilities: {} } });
      if (method === 'session/new') {
        const release = ${JSON.stringify(release ?? null)};
        if (release !== null) require('node:fs').writeFileSync(release + '.held', '');
        while (release !== null && !require('node:fs').existsSync(release)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
        if (catalog === 'signed_out') return reply({ error: { code: -32000, message: 'Please sign in. private-catalog-text' } });
        if (catalog === 'timeout') return;
        reply({ result: { sessionId: 'catalog-test', configOptions: catalog === 'malformed' ? 'private-catalog-text' : configOptions() } });
      }
      if (method === 'session/set_config_option') {
        if (params.configId === 'model') {
          if (models.find(entry => entry.id === params.value)?.efforts === 'unavailable') return reply({ error: { code: -32000, message: 'unavailable' } });
          model = models.find(entry => entry.id === params.value);
          effort = model?.efforts[0];
        } else {
          effort = params.value;
        }
        reply({ result: { configOptions: configOptions() } });
      }
    });
  } else {
    ${otherCommands}
  }
}
`;
}
