import type { AdoptionOperation, AdoptionRollbackMetadata } from "./operations";

function noRollback(description: string): AdoptionRollbackMetadata {
  return {
    strategy: "none",
    backup: "not-needed",
    description,
  };
}

export function rollbackMetadataForOperation(operation: AdoptionOperation): AdoptionRollbackMetadata {
  if (operation.status === "skipped") {
    return noRollback("No rollback is needed because this operation is skipped.");
  }

  switch (operation.kind) {
    case "mkdir":
      return {
        strategy: "remove-empty-directory",
        paths: [operation.path],
        backup: "not-needed",
        description: "Remove the created directory if it is still empty.",
      };
    case "writeFile":
      if (operation.ifMissing === true) {
        return {
          strategy: "delete-created-file",
          paths: [operation.path],
          backup: "not-needed",
          description: "Delete the file created by this if-missing operation.",
        };
      }
      return {
        strategy: "restore-or-delete-file",
        paths: [operation.path],
        backup: "runtime-fs-transaction",
        description: "rh config restore --repo puts back the file that the repository ledger keeps, or deletes the file that rh created.",
      };
    case "appendManagedBlock":
      return {
        strategy: "restore-or-delete-file",
        paths: [operation.path],
        backup: "runtime-fs-transaction",
        description: "rh config restore --repo puts back the file that the repository ledger keeps, or deletes the file that rh created.",
      };
    case "move":
      return {
        strategy: "manual",
        paths: [operation.path, operation.to],
        backup: "runtime-fs-transaction",
        description: "Move the destination back to the original path only if it has not changed since this transaction.",
      };
    case "remove":
      return {
        strategy: "manual",
        paths: [operation.path],
        backup: "runtime-fs-transaction",
        description: "A failed run restores the file from its run directory; a committed run keeps no copy of the retired file.",
      };
    case "gitUntrack":
      return {
        strategy: "manual",
        paths: [operation.path],
        description: "A failed run restores the index entry that it kept; a committed run keeps none.",
      };
    case "runCheck":
      return noRollback("No rollback is needed because this operation is a verification boundary.");
    default:
      return {
        strategy: "manual",
        paths: operation.path ? [operation.path] : undefined,
        description: "Manual rollback review is required for this reserved operation kind.",
      };
  }
}

export function withRollbackMetadata<T extends AdoptionOperation>(operation: T): T {
  return {
    ...operation,
    rollback: operation.rollback ?? rollbackMetadataForOperation(operation),
  };
}
