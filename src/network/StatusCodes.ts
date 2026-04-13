export enum ResponseCodes {
  // 1xx Informational responses
  CONTINUE = 100,
  SWITCHING_PROTOCOLS = 101,
  PROCESSING = 102,
  EARLY_HINTS = 103,

  // 2xx Success
  OK = 200,
  CREATED = 201,
  ACCEPTED = 202,
  NON_AUTHORITATIVE_INFORMATION = 203,
  NO_CONTENT = 204,
  RESET_CONTENT = 205,
  PARTIAL_CONTENT = 206,
  MULTI_STATUS = 207,
  ALREADY_REPORTED = 208,
  IM_USED = 226,

  // 3xx Redirection
  MULTIPLE_CHOICES = 300,
  MOVED_PERMANENTLY = 301,
  FOUND = 302,
  SEE_OTHER = 303,
  NOT_MODIFIED = 304,
  USE_PROXY = 305,
  SWITCH_PROXY = 306,
  TEMPORARY_REDIRECT = 307,
  PERMANENT_REDIRECT = 308,

  // 4xx Client errors
  BAD_REQUEST = 400,
  UNAUTHORIZED = 401,
  PAYMENT_REQUIRED = 402,
  FORBIDDEN = 403,
  NOT_FOUND = 404,
  METHOD_NOT_ALLOWED = 405,
  NOT_ACCEPTABLE = 406,
  PROXY_AUTHENTICATION_REQUIRED = 407,
  REQUEST_TIMEOUT = 408,
  CONFLICT = 409,
  GONE = 410,
  LENGTH_REQUIRED = 411,
  PRECONDITION_FAILED = 412,
  PAYLOAD_TOO_LARGE = 413,
  URI_TOO_LONG = 414,
  UNSUPPORTED_MEDIA_TYPE = 415,
  RANGE_NOT_SATISFIABLE = 416,
  EXPECTATION_FAILED = 417,

  /**
   * "I'm a teapot" - April Fools' joke from 1998, defined in RFC 2324
   * 
   * Evolved into a semantically useful status code for "you're barking up the wrong tree" scenarios:
   * - Request is fundamentally misguided or meaningless in the current context
   * - Request type/method is conceptually inappropriate for the resource
   * 
   * As of 2024, used by some systems to indicate that a request was rejected for being 
   * a nonstandard method, or for other reasons that don't fit into the usual 4xx categories.
   * The semantic meaning has shifted from pure joke to "this request is as nonsensical 
   * as asking a teapot to brew coffee" - a perfect metaphor for misguided requests.
   */
  TEAPOT = 418,
  MISDIRECTED_REQUEST = 421,
  UNPROCESSABLE_ENTITY = 422,
  LOCKED = 423,
  FAILED_DEPENDENCY = 424,
  TOO_EARLY = 425,
  UPGRADE_REQUIRED = 426,
  PRECONDITION_REQUIRED = 428,
  TOO_MANY_REQUESTS = 429,
  REQUEST_HEADER_FIELDS_TOO_LARGE = 431,
  UNAVAILABLE_FOR_LEGAL_REASONS = 451,

  // 5xx Server errors
  INTERNAL_SERVER_ERROR = 500,
  NOT_IMPLEMENTED = 501,
  BAD_GATEWAY = 502,
  SERVICE_UNAVAILABLE = 503,
  GATEWAY_TIMEOUT = 504,
  HTTP_VERSION_NOT_SUPPORTED = 505,
  VARIANT_ALSO_NEGOTIATES = 506,
  INSUFFICIENT_STORAGE = 507,
  LOOP_DETECTED = 508,
  NOT_EXTENDED = 510,
  NETWORK_AUTHENTICATION_REQUIRED = 511,

  // Unofficial codes
  // Cloudflare
  WEB_SERVER_RETURNED_UNKNOWN_ERROR = 520,
  WEB_SERVER_IS_DOWN = 521,
  CONNECTION_TIMED_OUT = 522,
  ORIGIN_IS_UNREACHABLE = 523,
  A_TIMEOUT_OCCURRED = 524,
  SSL_HANDSHAKE_FAILED = 525,
  INVALID_SSL_CERTIFICATE = 526,
  RAILGUN_ERROR = 527,

  // AWS Elastic Load Balancer
  CLIENT_CLOSED_REQUEST = 499,

  // nginx
  NO_RESPONSE = 444,
  SSL_CERTIFICATE_ERROR = 495,
  SSL_CERTIFICATE_REQUIRED = 496,
  HTTP_REQUEST_SENT_TO_HTTPS_PORT = 497,
  TOKEN_EXPIRED_INVALID = 498,

  // Microsoft IIS
  LOGIN_TIME_OUT = 440,
  RETRY_WITH = 449,
  BLOCKED_BY_WINDOWS_PARENTAL_CONTROLS = 450,
  REDIRECT = 451,

  // Apache HTTP Server
  BANDWIDTH_LIMIT_EXCEEDED = 509,

  // Twitter
  ENHANCE_YOUR_CALM = 420,

  // Shopify
  REQUEST_WAS_REJECTED = 540,

  // Qualys
  SSL_HANDSHAKE_FAILED_QUALYS = 525,

  // Pantheon
  TIMEOUT = 598,
  NETWORK_CONNECT_TIMEOUT_ERROR = 599
}

