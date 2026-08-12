# Input Parsers

`InputParserRegistry` ships JSON, YAML, Markdown, plain-text, and structured-task parsers. Every parser returns a normalized record with source format, raw input, parsed JSON value, metadata, and warnings.

An optional Zod schema is applied after parsing and before execution. Schema failures raise `INPUT_SCHEMA_ERROR`; values are not coerced to bypass expected types. Structured tasks are validated against the canonical task schema.

`NaturalLanguageTaskParser` produces a proposal containing an objective, requested capabilities, suggested agent, constraints, and requested tools. The proposal always has `executable: false`. A caller must validate and authorize it before turning it into a workflow or action.

Markdown front matter is parsed as YAML, while the body and heading index remain data. Embedded instructions do not inherit runtime authority.
