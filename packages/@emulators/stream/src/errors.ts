/** A Stream API error: the body every Stream SDK parses into its own error type. */
export class StreamApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

export const INPUT_ERROR = 4;
export const NOT_FOUND = 16;
export const NOT_ALLOWED = 17;

export function inputError(message: string): StreamApiError {
  return new StreamApiError(400, INPUT_ERROR, message);
}

export function notFound(message: string): StreamApiError {
  return new StreamApiError(404, NOT_FOUND, message);
}

export function notAllowed(message: string): StreamApiError {
  return new StreamApiError(403, NOT_ALLOWED, message);
}

export function errorBody(status: number, code: number, message: string): Record<string, unknown> {
  return {
    code,
    message,
    exception_fields: {},
    StatusCode: status,
    duration: "0.00ms",
    more_info: "https://getstream.io/chat/docs/api_errors_response",
    details: [],
  };
}
