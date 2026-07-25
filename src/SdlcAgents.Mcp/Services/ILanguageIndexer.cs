namespace SdlcAgents.Mcp.Services;

/// <summary>
/// A per-language backend that parses a set of source files and answers the
/// symbol / reference queries the SDLC tools need. <see cref="CodeIndex"/> owns
/// directory walking, aux/config files, text search and file lookup, and simply
/// aggregates across the registered indexers — so adding a language is additive
/// and cannot change another language's results.
///
/// C# is served by the Roslyn-backed <see cref="CSharpIndexer"/> (unchanged
/// behaviour). Java / TypeScript / JavaScript are served by lightweight
/// syntactic indexers; those are the drop-in point for a full tree-sitter
/// backend later — the interface and every tool above it stay the same.
/// </summary>
public interface ILanguageIndexer
{
    /// <summary>Human-readable language name, e.g. "C#", "Java", "TypeScript/JS".</summary>
    string Name { get; }

    /// <summary>True if this indexer parses files with the given lower-case extension (".cs").</summary>
    bool Handles(string extensionLower);

    /// <summary>Parse and index the given (repo-relative, absolute) file pairs.</summary>
    void Build(IReadOnlyList<(string Rel, string Full)> files);

    /// <summary>Files this indexer parsed (for text search, file lookup and counts).</summary>
    IReadOnlyList<SourceFile> Files { get; }

    /// <summary>Declarations of a simple symbol name.</summary>
    IReadOnlyList<SymbolDef> FindDeclarations(string name);

    /// <summary>Candidate references to a simple symbol name (declarations excluded).</summary>
    IReadOnlyList<Reference> FindReferences(string name);
}
