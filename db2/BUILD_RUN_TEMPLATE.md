# Db2 COBOL build and run template

This is a completion template, not runnable JCL. The repository does not
identify the target Db2 subsystem, cataloged procedures, compiler options,
load libraries, collection/package/plan names, bind settings, or runtime
permissions. A site administrator or course example must supply every
placeholder before use.

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
4. Run through the approved Db2 batch attachment. Do not use the file-only
   `EXEC PGM=RECONCIL` step as evidence of embedded-SQL execution.
5. Supply a unique run ID to the program's command-line parameter for every
   run. In the current master JCL this is the unresolved `RECON_RUN_ID`
   symbolic parameter; connect it to the site's approved symbol/procedure
   mechanism before execution. Do not replace it with a production hardcoded
   sample value.
6. Capture SQL return information, COBOL return code, and the result rows for
   that run before allowing the EOD publication gate to run.

The `RECONCIL` source sets RC 8 or higher on an insert or commit error. The
publication gate must therefore use the return code from this Db2-attached
execution, not from an unprecompiled file-only build.
