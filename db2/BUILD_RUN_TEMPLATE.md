# Db2 COBOL build and run template (deferred)

This is a deferred-integration template, not runnable JCL. The current
`RECONCIL.cbl` and `MASTER.jcl` are file-based and contain no embedded SQL
or Db2 runtime calls. This template documents what will be required when Db2
permissions (currently blocked by SQLCODE -551) become available.

The repository does not identify the target Db2 subsystem, cataloged
procedures, compiler options, load libraries, collection/package/plan names,
bind settings, or runtime permissions. A site administrator or course example
must supply every placeholder before use.

## Required site decisions

| Item | Site value |
|---|---|
| Db2 subsystem ID | `<DB2_SUBSYSTEM>` |
| Db2 precompile procedure or coprocessor command | `<DB2_PRECOMPILE_METHOD>` |
| COBOL compiler/link-edit procedure and options | `<COBOL_BUILD_METHOD>` |
| Db2 load libraries and order | `<DB2_LOAD_LIBRARIES>` |
| Application load library | `<APPLICATION_LOAD_LIBRARY>` |
| Collection | `<COLLECTION>` |
| Package name | `<PACKAGE>` |
| Plan name | `<PLAN>` |
| Bind owner, qualifier, and options | `<BIND_SETTINGS>` |
| DSN batch attachment/runtime procedure | `<DB2_RUN_METHOD>` |
| Required authorization | `<RUNTIME_PERMISSIONS>` |

## Required build sequence

1. Precompile `cobol/RECONCIL.cbl` using the approved method and retain the
   precompiler listing and generated DBRM.
2. Compile and link the generated COBOL source with the approved options and
   libraries.
3. Bind the DBRM into the approved collection/package and bind or update the
   approved plan using the site's settings.
4. Run through the approved Db2 batch attachment. Do not use the current
   file-only `EXEC PGM=RECONCIL` step as evidence of embedded-SQL execution.
5. Supply a unique run ID to the Db2-attached program's command-line parameter
   for every run. The current file-based master JCL has no run-ID symbol;
   a run-ID parameter must be added when the Db2 execution path is built.
   Connect it to the site's approved symbol/procedure mechanism. Do not
   replace it with a hardcoded sample value.
6. Capture SQL return information, COBOL return code, and the result rows for
   that run before allowing the EOD publication gate to run.

The future Db2-attached `RECONCIL` must set RC 8 or higher on an insert or
commit error. The publication gate must use the return code from that
Db2-attached execution, not from the current file-only build.

The current file-based COBOL returns RC 0 (clean), RC 4 (business exceptions),
or RC 8 or higher (technical file errors). It has no SQL, no run-ID parameter,
no inserts, and no commits.
