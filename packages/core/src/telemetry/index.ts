// SPDX-License-Identifier: Apache-2.0
export {
  type Attributes,
  type AttributeValue,
  type Classified,
  classify,
  FAULT_OF_CODE,
  type Fault,
  isServiceError,
  KNOWN_METHODS,
  type Outcome,
  RESOURCE_ATTRIBUTES,
  SPAN_ATTRIBUTES,
  type SpanFacts,
  sanitizeAttributes,
  sanitizeResource,
  spanAttributes,
} from './attributes.ts';
export {
  createOtlpExporter,
  type FinishedSpan,
  type OtlpExporterOptions,
  otlpEndpoint,
  otlpHeaders,
  type SpanExporter,
  traceRequest,
} from './otlp.ts';
export {
  createTelemetry,
  flushPeriodically,
  type SpanInput,
  type Telemetry,
  type TelemetryOptions,
  telemetryResource,
} from './telemetry.ts';
export { hex, parseTraceparent, type TraceParent } from './trace-context.ts';
