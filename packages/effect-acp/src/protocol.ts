import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Stdio from "effect/Stdio";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import * as RpcClientError from "effect/unstable/rpc/RpcClientError";
import * as RpcMessage from "effect/unstable/rpc/RpcMessage";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as RpcServer from "effect/unstable/rpc/RpcServer";

import * as AcpSchema from "./_generated/schema.gen.ts";
import { CLIENT_METHODS } from "./_generated/meta.gen.ts";
import * as AcpError from "./errors.ts";
const isAcpError = Schema.is(AcpError.AcpError);

export interface AcpProtocolLogEvent {
  readonly direction: "incoming" | "outgoing";
  readonly stage: "raw" | "decoded" | "decode_failed";
  readonly payload: unknown;
}

export type AcpIncomingNotification =
  | {
      readonly _tag: "SessionUpdate";
      readonly method: typeof CLIENT_METHODS.session_update;
      readonly params: AcpSchema.SessionNotification;
    }
  | {
      readonly _tag: "ElicitationComplete";
      readonly method: typeof CLIENT_METHODS.session_elicitation_complete;
      readonly params: AcpSchema.ElicitationCompleteNotification;
    }
  | {
      readonly _tag: "ExtNotification";
      readonly method: string;
      readonly params: unknown;
    };

export interface AcpPatchedProtocolOptions {
  readonly stdio: Stdio.Stdio;
  readonly terminationError?: Effect.Effect<AcpError.AcpError>;
  readonly serverRequestMethods: ReadonlySet<string>;
  readonly wireCompatibility?: AcpWireCompatibilityOptions;
  readonly logIncoming?: boolean;
  readonly logOutgoing?: boolean;
  readonly logger?: (event: AcpProtocolLogEvent) => Effect.Effect<void, never>;
  readonly onNotification?: (
    notification: AcpIncomingNotification,
  ) => Effect.Effect<void, AcpError.AcpError, never>;
  readonly onExtRequest?: (
    method: string,
    params: unknown,
  ) => Effect.Effect<unknown, AcpError.AcpError, never>;
  readonly onTermination?: (error: AcpError.AcpError) => Effect.Effect<void, never, never>;
}

export interface AcpPatchedProtocol {
  readonly clientProtocol: RpcClient.Protocol["Service"];
  readonly serverProtocol: RpcServer.Protocol["Service"];
  readonly incoming: Stream.Stream<AcpIncomingNotification>;
  readonly request: (method: string, payload: unknown) => Effect.Effect<unknown, AcpError.AcpError>;
  readonly notify: (method: string, payload: unknown) => Effect.Effect<void, AcpError.AcpError>;
}

export interface AcpWireCompatibilityOptions {
  /**
   * ACP is newline-delimited JSON-RPC, but some CLIs have emitted
   * pretty-printed JSON during early startup. Enable this for agents where we
   * prefer bounded tolerance over failing the whole session on framing drift.
   */
  readonly tolerateMultilineJson?: boolean;
  /**
   * When multiline tolerance is enabled, ignore non-JSON stdout lines instead
   * of failing the protocol. Stderr should still carry diagnostics.
   */
  readonly ignoreNonJsonStdout?: boolean;
}

interface AcpPendingRequest {
  readonly deferred: Deferred.Deferred<unknown, AcpError.AcpError>;
  readonly method: string;
}

const decodeSessionUpdate = Schema.decodeUnknownEffect(AcpSchema.SessionNotification);
const decodeElicitationComplete = Schema.decodeUnknownEffect(
  AcpSchema.ElicitationCompleteNotification,
);
const parserFactory = RpcSerialization.ndJsonRpc();
const isRpcServerCompatibleRequestId = (requestId: string) => /^(0|[1-9]\d*)$/.test(requestId);

export const makeAcpPatchedProtocol = Effect.fn("makeAcpPatchedProtocol")(function* (
  options: AcpPatchedProtocolOptions,
): Effect.fn.Return<AcpPatchedProtocol, never, Scope.Scope> {
  const parser = parserFactory.makeUnsafe();
  const wireDecoder = makeWireCompatibilityDecoder(options.wireCompatibility);
  const serverQueue = yield* Queue.unbounded<RpcMessage.FromClientEncoded>();
  const clientQueue = yield* Queue.unbounded<RpcMessage.FromServerEncoded>();
  const notificationQueue = yield* Queue.unbounded<AcpIncomingNotification>();
  const disconnects = yield* Queue.unbounded<number>();
  const outgoing = yield* Queue.unbounded<string | Uint8Array, Cause.Done<void>>();
  const nextRequestId = yield* Ref.make(1n);
  const nextServerRequestId = yield* Ref.make(1n);
  const serverRequestIdAliases = yield* Ref.make(new Map<string, string>());
  const serverNativeRequestIds = yield* Ref.make(new Set<string>());
  const terminationHandled = yield* Ref.make(false);
  const extPending = yield* Ref.make(new Map<string, AcpPendingRequest>());

  const logProtocol = (event: AcpProtocolLogEvent) => {
    if (event.direction === "incoming" && !options.logIncoming) {
      return Effect.void;
    }
    if (event.direction === "outgoing" && !options.logOutgoing) {
      return Effect.void;
    }
    return (
      options.logger?.(event) ??
      Effect.logDebug("ACP protocol event").pipe(Effect.annotateLogs({ event }))
    );
  };

  const encodeNonNumericExit = (
    message: Extract<RpcMessage.FromServerEncoded, { readonly _tag: "Exit" }>,
  ): string | undefined => {
    if (isRpcServerCompatibleRequestId(message.requestId)) {
      return undefined;
    }

    if (message.exit._tag === "Success") {
      return `${JSON.stringify({
        jsonrpc: "2.0",
        id: message.requestId,
        result: message.exit.value,
      })}\n`;
    }

    const failure = message.exit.cause.find((entry) => entry._tag === "Fail");
    const error = failure?.error ?? {
      code: -32603,
      message: "Internal error",
    };
    return `${JSON.stringify({
      jsonrpc: "2.0",
      id: message.requestId,
      error,
    })}\n`;
  };

  // ACP client→agent notifications (e.g. `session/cancel`) are modeled by the
  // RPC layer as a Request with an empty id. Encoded generically they go on the
  // wire as a JSON-RPC *request* carrying `"id":""`, which strict agents reject
  // (kiro-cli replies `-32601 Method not found` because it only registers a
  // notification handler for these methods). Emit them as true JSON-RPC
  // notifications — no id — so cancel and friends are actually honored.
  const encodeClientNotification = (
    message: RpcMessage.FromClientEncoded | RpcMessage.FromServerEncoded,
  ): string | undefined => {
    if (message._tag !== "Request" || message.id !== "") {
      return undefined;
    }
    return `${JSON.stringify({
      jsonrpc: "2.0",
      method: message.tag,
      params: message.payload,
    })}\n`;
  };

  const offerOutgoing = Effect.fn("offerOutgoing")(function* (
    message: RpcMessage.FromClientEncoded | RpcMessage.FromServerEncoded,
  ) {
    yield* logProtocol({
      direction: "outgoing",
      stage: "decoded",
      payload: message,
    });

    const method = message._tag === "Request" ? message.tag : undefined;
    const encodedRequestId =
      message._tag === "Request"
        ? message.id
        : "requestId" in message
          ? message.requestId
          : undefined;
    const requestId = encodedRequestId === "" ? undefined : encodedRequestId;
    const encoded = yield* Effect.try({
      try: () =>
        (message._tag === "Exit" ? encodeNonNumericExit(message) : undefined) ??
        encodeClientNotification(message) ??
        parser.encode(message),
      catch: (cause) => AcpError.AcpProtocolParseError.fromEncodingError(method, requestId, cause),
    });

    if (encoded) {
      yield* logProtocol({
        direction: "outgoing",
        stage: "raw",
        payload: typeof encoded === "string" ? encoded : new TextDecoder().decode(encoded),
      });

      yield* Queue.offer(outgoing, encoded).pipe(Effect.asVoid);
    }
  });

  const resolveExtPending = (
    requestId: string,
    onFound: (pendingRequest: AcpPendingRequest) => Effect.Effect<void>,
  ) =>
    Ref.modify(extPending, (pending) => {
      const pendingRequest = pending.get(requestId);
      if (!pendingRequest) {
        return [Effect.void, pending] as const;
      }
      const next = new Map(pending);
      next.delete(requestId);
      return [onFound(pendingRequest), next] as const;
    }).pipe(Effect.flatten);

  const removeExtPending = (requestId: string) =>
    Ref.update(extPending, (pending) => {
      if (!pending.has(requestId)) {
        return pending;
      }
      const next = new Map(pending);
      next.delete(requestId);
      return next;
    });

  const completeExtPendingFailure = (requestId: string, error: AcpError.AcpError) =>
    resolveExtPending(requestId, ({ deferred }) => Deferred.fail(deferred, error));

  const completeExtPendingSuccess = (requestId: string, value: unknown) =>
    resolveExtPending(requestId, ({ deferred }) => Deferred.succeed(deferred, value));

  const failAllExtPending = (error: AcpError.AcpError) =>
    Ref.getAndSet(extPending, new Map()).pipe(
      Effect.flatMap((pending) =>
        Effect.forEach([...pending.values()], ({ deferred }) => Deferred.fail(deferred, error), {
          discard: true,
        }),
      ),
    );

  const dispatchNotification = (notification: AcpIncomingNotification) =>
    Queue.offer(notificationQueue, notification).pipe(
      Effect.andThen(
        options.onNotification
          ? options.onNotification(notification).pipe(Effect.catch(() => Effect.void))
          : Effect.void,
      ),
      Effect.asVoid,
    );

  const emitClientProtocolError = (error: AcpError.AcpError) =>
    Queue.offer(clientQueue, {
      _tag: "ClientProtocolError",
      error: new RpcClientError.RpcClientError({
        reason: new RpcClientError.RpcClientDefect({
          message: "ACP protocol terminated.",
          cause: error,
        }),
      }),
    }).pipe(Effect.asVoid);

  const handleTermination = (classify: () => Effect.Effect<AcpError.AcpError | undefined>) =>
    Ref.modify(terminationHandled, (handled) => {
      if (handled) {
        return [Effect.void, true] as const;
      }
      return [
        Effect.gen(function* () {
          yield* Queue.offer(disconnects, 0);
          const error = yield* classify();
          if (!error) {
            return;
          }
          yield* failAllExtPending(error);
          yield* emitClientProtocolError(error);
          if (options.onTermination) {
            yield* options.onTermination(error);
          }
        }),
        true,
      ] as const;
    }).pipe(Effect.flatten);

  const respondWithSuccess = (requestId: string, value: unknown) =>
    offerOutgoing({
      _tag: "Exit",
      requestId,
      exit: {
        _tag: "Success",
        value,
      },
    });

  const respondWithError = (requestId: string, error: AcpError.AcpRequestError) =>
    offerOutgoing({
      _tag: "Exit",
      requestId,
      exit: {
        _tag: "Failure",
        cause: [
          {
            _tag: "Fail",
            error: error.toProtocolError(),
          },
        ],
      },
    });

  const handleExtRequest = (message: RpcMessage.RequestEncoded) => {
    if (!options.onExtRequest) {
      return respondWithError(message.id, AcpError.AcpRequestError.methodNotFound(message.tag));
    }
    return options.onExtRequest(message.tag, message.payload).pipe(
      Effect.matchEffect({
        onFailure: (error) =>
          respondWithError(
            message.id,
            AcpError.AcpRequestError.fromExtensionHandlerError(error, message.tag),
          ),
        onSuccess: (value) => respondWithSuccess(message.id, value),
      }),
    );
  };

  const allocateServerRequestAliasId = Effect.fn("allocateServerRequestAliasId")(function* () {
    const nativeRequestIds = yield* Ref.get(serverNativeRequestIds);
    const aliases = yield* Ref.get(serverRequestIdAliases);
    return yield* Ref.modify(nextServerRequestId, (current) => {
      let candidate = current;
      while (nativeRequestIds.has(String(candidate)) || aliases.has(String(candidate))) {
        candidate += 1n;
      }
      return [String(candidate), candidate + 1n] as const;
    });
  });

  const normalizeServerRequestId = (
    message: RpcMessage.RequestEncoded,
  ): Effect.Effect<RpcMessage.RequestEncoded> => {
    return Effect.all({
      aliases: Ref.get(serverRequestIdAliases),
      nativeRequestIds: Ref.get(serverNativeRequestIds),
    }).pipe(
      Effect.flatMap(({ aliases, nativeRequestIds }) => {
        if (
          isRpcServerCompatibleRequestId(message.id) &&
          !aliases.has(message.id) &&
          !nativeRequestIds.has(message.id)
        ) {
          return Ref.update(serverNativeRequestIds, (requestIds) => {
            const next = new Set(requestIds);
            next.add(message.id);
            return next;
          }).pipe(Effect.as(message));
        }

        return allocateServerRequestAliasId().pipe(
          Effect.flatMap((internalRequestId) =>
            Ref.update(serverRequestIdAliases, (aliases) => {
              const next = new Map(aliases);
              next.set(internalRequestId, message.id);
              return next;
            }).pipe(
              Effect.as({
                ...message,
                id: internalRequestId,
              }),
            ),
          ),
        );
      }),
    );
  };

  const restoreServerResponseRequestId = (
    response: RpcMessage.FromServerEncoded,
  ): Effect.Effect<RpcMessage.FromServerEncoded> => {
    if (!("requestId" in response) || typeof response.requestId !== "string") {
      return Effect.succeed(response);
    }

    return Ref.modify(serverRequestIdAliases, (aliases) => {
      const originalRequestId = aliases.get(response.requestId);
      if (!originalRequestId) {
        return [response, aliases] as const;
      }

      const next = new Map(aliases);
      if (response._tag === "Exit") {
        next.delete(response.requestId);
      }
      return [{ ...response, requestId: originalRequestId }, next] as const;
    }).pipe(
      Effect.flatMap((restoredResponse) => {
        if (restoredResponse !== response || response._tag !== "Exit") {
          return Effect.succeed(restoredResponse);
        }
        return Ref.update(serverNativeRequestIds, (requestIds) => {
          if (!requestIds.has(response.requestId)) {
            return requestIds;
          }
          const next = new Set(requestIds);
          next.delete(response.requestId);
          return next;
        }).pipe(Effect.as(response));
      }),
    );
  };

  const handleRequestEncoded = (message: RpcMessage.RequestEncoded) => {
    if (message.id === "") {
      if (message.tag === CLIENT_METHODS.session_update) {
        return decodeSessionUpdate(message.payload).pipe(
          Effect.map(
            (params) =>
              ({
                _tag: "SessionUpdate",
                method: CLIENT_METHODS.session_update,
                params,
              }) satisfies AcpIncomingNotification,
          ),
          Effect.mapError((cause) =>
            AcpError.AcpProtocolParseError.fromSchemaError(
              "decode-notification-payload",
              CLIENT_METHODS.session_update,
              cause,
            ),
          ),
          Effect.flatMap(dispatchNotification),
        );
      }
      if (message.tag === CLIENT_METHODS.session_elicitation_complete) {
        return decodeElicitationComplete(message.payload).pipe(
          Effect.map(
            (params) =>
              ({
                _tag: "ElicitationComplete",
                method: CLIENT_METHODS.session_elicitation_complete,
                params,
              }) satisfies AcpIncomingNotification,
          ),
          Effect.mapError((cause) =>
            AcpError.AcpProtocolParseError.fromSchemaError(
              "decode-notification-payload",
              CLIENT_METHODS.session_elicitation_complete,
              cause,
            ),
          ),
          Effect.flatMap(dispatchNotification),
        );
      }
      return dispatchNotification({
        _tag: "ExtNotification",
        method: message.tag,
        params: message.payload,
      });
    }

    if (!options.serverRequestMethods.has(message.tag)) {
      return handleExtRequest(message).pipe(
        Effect.catchTags({
          AcpProtocolParseError: (error) =>
            Effect.logWarning(error).pipe(
              Effect.annotateLogs({
                method: message.tag,
                requestId: message.id,
                operation: error.operation,
              }),
              Effect.andThen(
                respondWithError(
                  message.id,
                  AcpError.AcpRequestError.fromExtensionResponseEncodingError(
                    message.tag,
                    message.id,
                    error,
                  ),
                ),
              ),
            ),
        }),
        Effect.asVoid,
      );
    }

    return normalizeServerRequestId(message).pipe(
      Effect.flatMap((normalizedMessage) => Queue.offer(serverQueue, normalizedMessage)),
      Effect.asVoid,
    );
  };

  const handleExitEncoded = (message: RpcMessage.ResponseExitEncoded) => {
    const normalizedMessage = normalizeProtocolErrorExit(message);
    return Ref.get(extPending).pipe(
      Effect.flatMap((pending) => {
        if (!pending.has(normalizedMessage.requestId)) {
          return Queue.offer(clientQueue, normalizedMessage).pipe(Effect.asVoid);
        }
        const pendingRequest = pending.get(normalizedMessage.requestId);
        if (!pendingRequest) {
          return Queue.offer(clientQueue, normalizedMessage).pipe(Effect.asVoid);
        }
        if (normalizedMessage.exit._tag === "Success") {
          return completeExtPendingSuccess(
            normalizedMessage.requestId,
            normalizedMessage.exit.value,
          );
        }
        const failure = findProtocolErrorFailure(normalizedMessage.exit.cause);
        if (failure) {
          return completeExtPendingFailure(
            normalizedMessage.requestId,
            AcpError.AcpRequestError.fromProtocolError(failure, {
              method: pendingRequest.method,
              requestId: normalizedMessage.requestId,
              cause: normalizedMessage.exit.cause,
            }),
          );
        }
        return completeExtPendingFailure(
          normalizedMessage.requestId,
          AcpError.AcpRequestError.fromExtensionResponseFailure(
            pendingRequest.method,
            normalizedMessage.requestId,
            normalizedMessage.exit.cause,
          ),
        );
      }),
    );
  };

  const routeDecodedMessage = (
    message: RpcMessage.FromClientEncoded | RpcMessage.FromServerEncoded,
  ): Effect.Effect<void, AcpError.AcpError> => {
    switch (message._tag) {
      case "Request":
        return handleRequestEncoded(message);
      case "Exit":
        return handleExitEncoded(message);
      case "Chunk":
        return Ref.get(extPending).pipe(
          Effect.flatMap((pending) => {
            const pendingRequest = pending.get(message.requestId);
            return pendingRequest
              ? completeExtPendingFailure(
                  message.requestId,
                  AcpError.AcpRequestError.unsupportedStreamingResponse(
                    pendingRequest.method,
                    message.requestId,
                  ),
                )
              : Queue.offer(clientQueue, message).pipe(Effect.asVoid);
          }),
        );
      case "Defect":
      case "ClientProtocolError":
      case "Pong":
        return Queue.offer(clientQueue, message).pipe(Effect.asVoid);
      case "Ack":
      case "Interrupt":
      case "Ping":
      case "Eof":
        return Queue.offer(serverQueue, message).pipe(Effect.asVoid);
    }
  };

  const decodeWireMessages = (data: string | Uint8Array) =>
    Effect.try({
      try: () => {
        if (!wireDecoder) {
          return parser.decode(data) as ReadonlyArray<
            RpcMessage.FromClientEncoded | RpcMessage.FromServerEncoded
          >;
        }
        return wireDecoder
          .decode(data)
          .flatMap(
            (frame) =>
              parser.decode(`${compactJsonFrame(frame)}\n`) as ReadonlyArray<
                RpcMessage.FromClientEncoded | RpcMessage.FromServerEncoded
              >,
          );
      },
      catch: (cause) =>
        new AcpError.AcpProtocolParseError({
          operation: "decode-wire-message",
          cause,
        }),
    });

  const decodeFlushedWireMessages = () =>
    Effect.try({
      try: () => {
        if (!wireDecoder) {
          return [];
        }
        return wireDecoder
          .flush()
          .flatMap(
            (frame) =>
              parser.decode(`${compactJsonFrame(frame)}\n`) as ReadonlyArray<
                RpcMessage.FromClientEncoded | RpcMessage.FromServerEncoded
              >,
          );
      },
      catch: (cause) =>
        new AcpError.AcpProtocolParseError({
          operation: "decode-wire-message",
          cause,
        }),
    });

  const routeDecodedMessages = (
    messages: ReadonlyArray<RpcMessage.FromClientEncoded | RpcMessage.FromServerEncoded>,
  ) =>
    Effect.forEach(messages, routeDecodedMessage, {
      discard: true,
    });

  yield* options.stdio.stdin.pipe(
    Stream.runForEach((data) =>
      logProtocol({
        direction: "incoming",
        stage: "raw",
        payload: typeof data === "string" ? data : new TextDecoder().decode(data),
      }).pipe(
        Effect.flatMap(() => decodeWireMessages(data)),
        Effect.tap((messages) =>
          logProtocol({
            direction: "incoming",
            stage: "decoded",
            payload: messages,
          }),
        ),
        Effect.tapErrorTag("AcpProtocolParseError", (error) =>
          logProtocol({
            direction: "incoming",
            stage: "decode_failed",
            payload: {
              operation: error.operation,
              ...(error.method === undefined ? {} : { method: error.method }),
              ...(error.requestId === undefined ? {} : { requestId: error.requestId }),
              ...(error.issueCount === undefined ? {} : { issueCount: error.issueCount }),
              ...(error.issueKinds === undefined ? {} : { issueKinds: error.issueKinds }),
              ...(error.maximumPathDepth === undefined
                ? {}
                : { maximumPathDepth: error.maximumPathDepth }),
            },
          }),
        ),
        Effect.flatMap(routeDecodedMessages),
      ),
    ),
    Effect.matchEffect({
      onFailure: (error) => {
        const normalized: AcpError.AcpError = isAcpError(error)
          ? error
          : new AcpError.AcpTransportError({
              operation: "read-input-stream",
              cause: error,
            });
        return handleTermination(() => Effect.succeed(normalized));
      },
      onSuccess: () =>
        decodeFlushedWireMessages().pipe(
          Effect.flatMap(routeDecodedMessages),
          Effect.catch((error) => handleTermination(() => Effect.succeed(error))),
          Effect.andThen(
            handleTermination(
              () =>
                options.terminationError ??
                Effect.succeed(new AcpError.AcpInputStreamEndedError({})),
            ),
          ),
        ),
    }),
    Effect.forkScoped,
  );

  yield* Stream.fromQueue(outgoing).pipe(Stream.run(options.stdio.stdout()), Effect.forkScoped);

  const clientProtocol = RpcClient.Protocol.of({
    run: (_clientId, f) =>
      Stream.fromQueue(clientQueue).pipe(
        Stream.runForEach((message) => f(message)),
        Effect.forever,
      ),
    send: (_clientId, request) =>
      offerOutgoing(request).pipe(
        Effect.mapError(
          (error) =>
            new RpcClientError.RpcClientError({
              reason: new RpcClientError.RpcClientDefect({
                message: "Failed to send ACP protocol message.",
                cause: error,
              }),
            }),
        ),
      ),
    supportsAck: true,
    supportsTransferables: false,
  });

  const serverProtocol = RpcServer.Protocol.of({
    run: (f) =>
      Stream.fromQueue(serverQueue).pipe(
        Stream.runForEach((message) => f(0, message)),
        Effect.forever,
      ),
    disconnects,
    send: (_clientId, response) =>
      restoreServerResponseRequestId(response).pipe(Effect.flatMap(offerOutgoing), Effect.orDie),
    end: (_clientId) => Queue.end(outgoing),
    clientIds: Effect.succeed(new Set([0])),
    initialMessage: Effect.succeedNone,
    supportsAck: true,
    supportsTransferables: false,
    supportsSpanPropagation: true,
  });

  const sendNotification = Effect.fn("sendNotification")(function* (
    method: string,
    payload: unknown,
  ) {
    yield* offerOutgoing({
      _tag: "Request",
      id: "",
      tag: method,
      payload,
      headers: [],
    });
  });

  const sendRequest = Effect.fn("sendRequest")(function* (method: string, payload: unknown) {
    const requestId = yield* Ref.modify(
      nextRequestId,
      (current) => [current, current + 1n] as const,
    );
    const deferred = yield* Deferred.make<unknown, AcpError.AcpError>();
    yield* Ref.update(extPending, (pending) =>
      new Map(pending).set(String(requestId), { deferred, method }),
    );
    yield* offerOutgoing({
      _tag: "Request",
      id: String(requestId),
      tag: method,
      payload,
      headers: [],
    }).pipe(Effect.tapError(() => removeExtPending(String(requestId))));
    return yield* Deferred.await(deferred).pipe(
      Effect.onInterrupt(() => removeExtPending(String(requestId))),
    );
  });

  return {
    clientProtocol,
    serverProtocol,
    get incoming() {
      return Stream.fromQueue(notificationQueue);
    },
    request: sendRequest,
    notify: sendNotification,
  } satisfies AcpPatchedProtocol;
});

type ProtocolError = { code: number; message: string; data?: unknown };
type ProtocolFailureCause = Extract<
  RpcMessage.ResponseExitEncoded["exit"],
  { readonly _tag: "Failure" }
>["cause"];

function isProtocolError(value: unknown): value is ProtocolError {
  return (
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    typeof value.code === "number" &&
    "message" in value &&
    typeof value.message === "string"
  );
}

function normalizeProtocolErrorExit(
  message: RpcMessage.ResponseExitEncoded,
): RpcMessage.ResponseExitEncoded {
  if (message.exit._tag !== "Failure") {
    return message;
  }

  let changed = false;
  const cause = message.exit.cause.map((entry) => {
    if (entry._tag !== "Die" || !isProtocolError(entry.defect)) {
      return entry;
    }
    changed = true;
    return {
      _tag: "Fail" as const,
      error: entry.defect,
    };
  });

  return changed
    ? {
        ...message,
        exit: {
          _tag: "Failure" as const,
          cause,
        },
      }
    : message;
}

function findProtocolErrorFailure(cause: ProtocolFailureCause): ProtocolError | undefined {
  for (const entry of cause) {
    if (entry._tag === "Fail" && isProtocolError(entry.error)) {
      return entry.error;
    }
  }
  return undefined;
}

interface WireCompatibilityDecoder {
  readonly decode: (data: string | Uint8Array) => ReadonlyArray<string>;
  readonly flush: () => ReadonlyArray<string>;
}

const MAX_MULTILINE_JSON_LENGTH = 128_000;
const MAX_MULTILINE_JSON_LINES = 256;

function makeWireCompatibilityDecoder(
  options: AcpWireCompatibilityOptions | undefined,
): WireCompatibilityDecoder | undefined {
  if (options?.tolerateMultilineJson !== true) {
    return undefined;
  }

  const decoder = new TextDecoder();
  let buffer = "";
  let pendingJson = "";
  let pendingJsonLineCount = 0;

  const resetPendingJson = () => {
    pendingJson = "";
    pendingJsonLineCount = 0;
  };

  const tryEmit = (candidate: string, frames: Array<string>): boolean => {
    try {
      JSON.parse(candidate);
      frames.push(candidate);
      return true;
    } catch {
      return false;
    }
  };

  const handleLine = (line: string, frames: Array<string>): void => {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    if (pendingJson) {
      const nextCandidate = `${pendingJson}\n${trimmed}`;
      if (tryEmit(nextCandidate, frames)) {
        resetPendingJson();
        return;
      }
      pendingJsonLineCount += 1;
      if (
        classifyJsonContainer(nextCandidate) === "incomplete" &&
        nextCandidate.length <= MAX_MULTILINE_JSON_LENGTH &&
        pendingJsonLineCount <= MAX_MULTILINE_JSON_LINES
      ) {
        pendingJson = nextCandidate;
        return;
      }
      resetPendingJson();
      handleLine(trimmed, frames);
      return;
    }

    if (tryEmit(trimmed, frames)) {
      return;
    }

    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      pendingJson = trimmed;
      pendingJsonLineCount = 1;
      return;
    }

    if (options.ignoreNonJsonStdout === true) {
      return;
    }

    // Preserve strict failure semantics for invalid JSON when callers only ask
    // for multiline tolerance. Feeding the raw line through the parser keeps the
    // existing error shape.
    frames.push(trimmed);
  };

  return {
    decode: (data) => {
      const frames: Array<string> = [];
      buffer += typeof data === "string" ? data : decoder.decode(data);
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        handleLine(line, frames);
      }
      return frames;
    },
    flush: () => {
      const frames: Array<string> = [];
      const remaining = buffer.trim();
      buffer = "";
      if (remaining) {
        handleLine(remaining, frames);
      }
      if (pendingJson && tryEmit(pendingJson, frames)) {
        resetPendingJson();
      }
      return frames;
    },
  };
}

function compactJsonFrame(frame: string): string {
  return JSON.stringify(JSON.parse(frame));
}

function classifyJsonContainer(input: string): "complete" | "incomplete" | "invalid" {
  const stack: Array<"{" | "["> = [];
  let inString = false;
  let escaped = false;
  let started = false;
  let complete = false;

  for (const char of input) {
    if (!started && /\s/.test(char)) {
      continue;
    }
    if (complete) {
      if (/\s/.test(char)) {
        continue;
      }
      return "invalid";
    }
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      if (!started) {
        return "invalid";
      }
      inString = true;
      continue;
    }
    if (char === "{" || char === "[") {
      if (!started) {
        started = true;
      }
      stack.push(char);
      continue;
    }
    if (char === "}" || char === "]") {
      const expected = char === "}" ? "{" : "[";
      if (stack.pop() !== expected) {
        return "invalid";
      }
      if (stack.length === 0) {
        complete = true;
      }
      continue;
    }
    if (!started && !/\s/.test(char)) {
      return "invalid";
    }
  }

  if (!started || inString || stack.length > 0) {
    return "incomplete";
  }
  return complete ? "complete" : "invalid";
}
