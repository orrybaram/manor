// Re-export of the shared push-error categorizer from src/lib so renderer and
// electron backend share a single implementation.
export {
  categorizePushError,
  type PushError,
  type PushErrorKind,
} from "../../src/lib/push-error";
