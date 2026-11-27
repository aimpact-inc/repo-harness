export const SEATS_CONFIG_UPDATE_ACTION = 'rh update';

export class SeatsConfigMigrationRequiredError extends Error {
  readonly code = 'seats_config_migration_required';
  readonly next_action = SEATS_CONFIG_UPDATE_ACTION;
  constructor() {
    super(`The stored seats section needs a one-shot migration. Run ${SEATS_CONFIG_UPDATE_ACTION}.`);
  }
}
