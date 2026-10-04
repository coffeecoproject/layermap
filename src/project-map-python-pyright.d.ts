// The part of Pyright's internal API the Python map worker uses, declared by hand. The worker is
// bundled against Pyright's own source at the version pinned in package.json (pyright-root); these
// declarations must follow that version. Only the worker imports these modules.

declare module "pyright-internal/common/uri/uri" {
  export interface CaseSensitivityDetector {
    isCaseSensitive(uri: string): boolean;
  }
  export interface Uri {
    readonly key: string;
    getFilePath(): string;
    isEmpty(): boolean;
    equals(other: Uri | undefined): boolean;
    combinePaths(...paths: string[]): Uri;
  }
  export namespace Uri {
    function file(path: string, detector: CaseSensitivityDetector): Uri;
  }
}

declare module "pyright-internal/common/serviceProviderExtensions" {
  export interface ServiceProvider {
    dispose(): void;
  }
  export function createServiceProvider(...services: unknown[]): ServiceProvider;
}

declare module "pyright-internal/common/console" {
  export class NullConsole {}
}

declare module "pyright-internal/common/host" {
  export class NoAccessHost {}
}

declare module "pyright-internal/common/pythonVersion" {
  export interface PythonVersion {
    readonly major: number;
    readonly minor: number;
  }
  export namespace PythonVersion {
    function create(major: number, minor: number): PythonVersion;
  }
}

declare module "pyright-internal/common/configOptions" {
  import type { PythonVersion } from "pyright-internal/common/pythonVersion";
  import type { Uri } from "pyright-internal/common/uri/uri";
  export class ConfigOptions {
    constructor(projectRoot: Uri);
    defaultPythonVersion?: PythonVersion | undefined;
    defaultPythonPlatform?: string | undefined;
    defaultExtraPaths?: Uri[] | undefined;
    typeshedPath?: Uri | undefined;
  }
}

declare module "pyright-internal/parser/parseNodes" {
  export enum ParseNodeType {
    Error = 0,
    Argument = 1,
    Assignment = 3,
    AugmentedAssignment = 5,
    Call = 9,
    Class = 10,
    Decorator = 16,
    Del = 17,
    Function = 31,
    Global = 32,
    Import = 23,
    ImportAs = 24,
    ImportFrom = 25,
    ImportFromAs = 26,
    Index = 27,
    Lambda = 33,
    List = 34,
    MemberAccess = 35,
    Module = 36,
    ModuleName = 37,
    Name = 38,
    Nonlocal = 39,
    Parameter = 41,
    StatementList = 47,
    StringList = 48,
    String = 49,
    Suite = 50,
    Tuple = 52,
    TypeAnnotation = 54,
    With = 58,
    WithItem = 59,
    TypeAlias = 77,
  }
  export interface ParseNodeBase<T extends ParseNodeType> {
    readonly nodeType: T;
    readonly start: number;
    readonly length: number;
    readonly id: number;
    parent: ParseNode | undefined;
  }
  export interface ModuleNode extends ParseNodeBase<ParseNodeType.Module> {
    d: { statements: ParseNode[] };
  }
  export interface SuiteNode extends ParseNodeBase<ParseNodeType.Suite> {
    d: { statements: ParseNode[] };
  }
  export interface StatementListNode extends ParseNodeBase<ParseNodeType.StatementList> {
    d: { statements: ParseNode[] };
  }
  export interface NameNode extends ParseNodeBase<ParseNodeType.Name> {
    d: { value: string };
  }
  export interface DecoratorNode extends ParseNodeBase<ParseNodeType.Decorator> {
    d: { expr: ParseNode };
  }
  export interface ArgumentNode extends ParseNodeBase<ParseNodeType.Argument> {
    d: { name: NameNode | undefined; valueExpr: ParseNode };
  }
  export interface ParameterNode extends ParseNodeBase<ParseNodeType.Parameter> {
    d: {
      name: NameNode | undefined;
      annotation: ParseNode | undefined;
      annotationComment: ParseNode | undefined;
      defaultValue: ParseNode | undefined;
    };
  }
  export interface ClassNode extends ParseNodeBase<ParseNodeType.Class> {
    d: { decorators: DecoratorNode[]; name: NameNode; arguments: ArgumentNode[]; suite: SuiteNode };
  }
  export interface FunctionNode extends ParseNodeBase<ParseNodeType.Function> {
    d: {
      decorators: DecoratorNode[];
      name: NameNode;
      params: ParameterNode[];
      returnAnnotation: ParseNode | undefined;
      suite: SuiteNode;
    };
  }
  export interface LambdaNode extends ParseNodeBase<ParseNodeType.Lambda> {
    d: { params: ParameterNode[]; expr: ParseNode };
  }
  export interface CallNode extends ParseNodeBase<ParseNodeType.Call> {
    d: { leftExpr: ParseNode; args: ArgumentNode[] };
  }
  export interface MemberAccessNode extends ParseNodeBase<ParseNodeType.MemberAccess> {
    d: { leftExpr: ParseNode; member: NameNode };
  }
  export interface IndexNode extends ParseNodeBase<ParseNodeType.Index> {
    d: { leftExpr: ParseNode; items: ArgumentNode[] };
  }
  export interface WithNode extends ParseNodeBase<ParseNodeType.With> {
    d: { isAsync?: boolean; withItems: WithItemNode[]; suite: SuiteNode };
  }
  export interface WithItemNode extends ParseNodeBase<ParseNodeType.WithItem> {
    d: { expr: ParseNode; target?: ParseNode };
  }
  export interface AssignmentNode extends ParseNodeBase<ParseNodeType.Assignment> {
    d: { leftExpr: ParseNode; rightExpr: ParseNode };
  }
  export interface AugmentedAssignmentNode
    extends ParseNodeBase<ParseNodeType.AugmentedAssignment> {
    d: { leftExpr: ParseNode; rightExpr: ParseNode };
  }
  export interface TypeAnnotationNode extends ParseNodeBase<ParseNodeType.TypeAnnotation> {
    d: { valueExpr: ParseNode; annotation: ParseNode };
  }
  export interface DelNode extends ParseNodeBase<ParseNodeType.Del> {
    d: { targets: ParseNode[] };
  }
  export interface GlobalNode extends ParseNodeBase<ParseNodeType.Global> {
    d: { targets: NameNode[] };
  }
  export interface NonlocalNode extends ParseNodeBase<ParseNodeType.Nonlocal> {
    d: { targets: NameNode[] };
  }
  export interface ModuleNameNode extends ParseNodeBase<ParseNodeType.ModuleName> {
    d: { leadingDots: number; nameParts: NameNode[] };
  }
  export interface ImportAsNode extends ParseNodeBase<ParseNodeType.ImportAs> {
    d: { module: ModuleNameNode; alias?: NameNode | undefined };
  }
  export interface ImportNode extends ParseNodeBase<ParseNodeType.Import> {
    d: { list: ImportAsNode[] };
  }
  export interface ImportFromAsNode extends ParseNodeBase<ParseNodeType.ImportFromAs> {
    d: { name: NameNode; alias?: NameNode | undefined };
  }
  export interface ImportFromNode extends ParseNodeBase<ParseNodeType.ImportFrom> {
    d: { module: ModuleNameNode; imports: ImportFromAsNode[]; isWildcardImport: boolean };
  }
  export interface TupleNode extends ParseNodeBase<ParseNodeType.Tuple> {
    d: { items: ParseNode[] };
  }
  export interface ListNode extends ParseNodeBase<ParseNodeType.List> {
    d: { items: ParseNode[] };
  }
  export interface StringNode extends ParseNodeBase<ParseNodeType.String> {
    d: { value: string };
  }
  export interface StringListNode extends ParseNodeBase<ParseNodeType.StringList> {
    d: { strings: ParseNode[] };
  }
  export interface TypeAliasNode extends ParseNodeBase<ParseNodeType.TypeAlias> {
    d: { name: NameNode; expr: ParseNode };
  }
  export interface ErrorNode extends ParseNodeBase<ParseNodeType.Error> {
    d: object;
  }
  export type ParseNode =
    | ModuleNode
    | SuiteNode
    | StatementListNode
    | NameNode
    | DecoratorNode
    | ArgumentNode
    | ParameterNode
    | ClassNode
    | FunctionNode
    | LambdaNode
    | CallNode
    | MemberAccessNode
    | IndexNode
    | AssignmentNode
    | AugmentedAssignmentNode
    | TypeAnnotationNode
    | DelNode
    | GlobalNode
    | NonlocalNode
    | ModuleNameNode
    | ImportAsNode
    | ImportNode
    | ImportFromAsNode
    | ImportFromNode
    | TupleNode
    | ListNode
    | StringNode
    | StringListNode
    | TypeAliasNode
    | ErrorNode
    | ParseNodeBase<ParseNodeType>;
}

declare module "pyright-internal/analyzer/parseTreeWalker" {
  import type {
    AssignmentNode,
    AugmentedAssignmentNode,
    CallNode,
    ClassNode,
    DelNode,
    FunctionNode,
    GlobalNode,
    ImportFromNode,
    ImportNode,
    LambdaNode,
    MemberAccessNode,
    NameNode,
    ParseNode,
    TypeAliasNode,
    TypeAnnotationNode,
    WithNode,
  } from "pyright-internal/parser/parseNodes";
  export class ParseTreeWalker {
    walk(node: ParseNode): void;
    walkMultiple(nodes: (ParseNode | undefined)[]): void;
    visitAssignment(node: AssignmentNode): boolean;
    visitAugmentedAssignment(node: AugmentedAssignmentNode): boolean;
    visitCall(node: CallNode): boolean;
    visitClass(node: ClassNode): boolean;
    visitDel(node: DelNode): boolean;
    visitFunction(node: FunctionNode): boolean;
    visitGlobal(node: GlobalNode): boolean;
    visitImport(node: ImportNode): boolean;
    visitImportFrom(node: ImportFromNode): boolean;
    visitLambda(node: LambdaNode): boolean;
    visitMemberAccess(node: MemberAccessNode): boolean;
    visitName(node: NameNode): boolean;
    visitTypeAlias(node: TypeAliasNode): boolean;
    visitTypeAnnotation(node: TypeAnnotationNode): boolean;
    visitWith(node: WithNode): boolean;
  }
}

declare module "pyright-internal/analyzer/parseTreeUtils" {
  import type { ParseNode } from "pyright-internal/parser/parseNodes";
  export function getDocString(statements: ParseNode[]): string | undefined;
}

declare module "pyright-internal/analyzer/declaration" {
  import type { Uri } from "pyright-internal/common/uri/uri";
  import type { ParseNode } from "pyright-internal/parser/parseNodes";
  export enum DeclarationType {
    Intrinsic = 0,
    Variable = 1,
    Param = 2,
    TypeParam = 3,
    TypeAlias = 4,
    Function = 5,
    Class = 6,
    SpecialBuiltInClass = 7,
    Alias = 8,
  }
  export interface Declaration {
    type: DeclarationType;
    node: ParseNode;
    uri: Uri;
    moduleName: string;
  }
}

declare module "pyright-internal/analyzer/importResult" {
  import type { Uri } from "pyright-internal/common/uri/uri";
  export enum ImportType {
    BuiltIn = 0,
    ThirdParty = 1,
    Local = 2,
  }
  export interface ImplicitImport {
    name: string;
    uri: Uri;
  }
  export interface ImportResult {
    isImportFound: boolean;
    isNamespacePackage: boolean;
    importType: ImportType;
    resolvedUris: Uri[];
    isStdlibTypeshedFile?: boolean;
    filteredImplicitImports?: Map<string, ImplicitImport>;
  }
}

declare module "pyright-internal/analyzer/types" {
  import type { Declaration } from "pyright-internal/analyzer/declaration";
  // Pyright's Symbol (analyzer/symbol), as class members expose it.
  export interface MemberSymbol {
    getDeclarations(): Declaration[];
  }
  export interface Type {
    readonly category: number;
  }
  export interface ClassType extends Type {
    readonly shared: {
      readonly fullName: string;
      readonly fields: Map<string, MemberSymbol>;
      readonly declaration?: Declaration | undefined;
      readonly typeParams: readonly unknown[];
    };
  }
  export namespace ClassType {
    function isProtocolClass(classType: ClassType): boolean;
    function isEnumClass(classType: ClassType): boolean;
    function cloneAsInstance(type: ClassType): ClassType;
    function derivesFromAnyOrUnknown(classType: ClassType): boolean;
  }
  export function isClass(type: Type): type is ClassType;
  export function isClassInstance(type: Type): type is ClassType;
}

declare module "pyright-internal/analyzer/typeUtils" {
  import type { ClassType, MemberSymbol, Type } from "pyright-internal/analyzer/types";
  export enum MemberAccessFlags {
    Default = 0,
    SkipOriginalClass = 1,
    SkipInstanceMembers = 16,
  }
  export interface ClassMember {
    symbol: MemberSymbol;
  }
  export function lookUpClassMember(
    classType: ClassType,
    memberName: string,
    flags?: MemberAccessFlags,
  ): ClassMember | undefined;
  // Calls back with each member of a union, or with the type itself.
  export function doForEachSubtype(type: Type, callback: (subtype: Type) => void): void;
}

declare module "pyright-internal/analyzer/typeEvaluatorTypes" {
  import type { Declaration } from "pyright-internal/analyzer/declaration";
  import type { ClassType, Type } from "pyright-internal/analyzer/types";
  import type { ClassNode, NameNode, ParseNode } from "pyright-internal/parser/parseNodes";
  export interface TypeEvaluator {
    getDeclInfoForNameNode(node: NameNode): { decls: Declaration[] } | undefined;
    resolveAliasDeclaration(
      declaration: Declaration,
      resolveLocalNames: boolean,
    ): Declaration | undefined;
    getTypeOfClass(node: ClassNode): { classType: ClassType } | undefined;
    getType(node: ParseNode): Type | undefined;
    // A TypeVar (such as the synthesized type of self) as its bound or constraints.
    makeTopLevelTypeVarsConcrete(type: Type): Type;
    assignType(destType: Type, srcType: Type): boolean;
  }
}

declare module "pyright-internal/analyzer/analyzerNodeInfo" {
  import type { ImportResult } from "pyright-internal/analyzer/importResult";
  import type { ParseNode } from "pyright-internal/parser/parseNodes";
  export interface AnalyzerNodeInfoReader {
    readonly brand?: "AnalyzerNodeInfoReader";
  }
  export function getInfoReader(provider: {
    readonly analyzerNodeInfoReader: AnalyzerNodeInfoReader;
  }): AnalyzerNodeInfoReader;
  export function getImportInfo(
    node: ParseNode,
    reader: AnalyzerNodeInfoReader,
  ): ImportResult | undefined;
}

declare module "pyright-internal/common/diagnostic" {
  export enum DiagnosticCategory {
    Error = 0,
    Warning = 1,
  }
  export interface Diagnostic {
    readonly category: DiagnosticCategory;
  }
}

declare module "pyright-internal/analyzer/importResolver" {
  import type { ImportResult } from "pyright-internal/analyzer/importResult";
  import type { ConfigOptions } from "pyright-internal/common/configOptions";
  import type { ServiceProvider } from "pyright-internal/common/serviceProviderExtensions";
  import type { Uri } from "pyright-internal/common/uri/uri";
  export interface ExecutionEnvironment {
    readonly root?: Uri;
    readonly extraPaths: readonly Uri[];
  }
  export interface ImportedModuleDescriptor {
    readonly leadingDots: number;
    readonly nameParts: readonly string[];
  }
  export class ImportResolver {
    constructor(serviceProvider: ServiceProvider, configOptions: ConfigOptions, host: unknown);
    protected fileExistsCached(uri: Uri): boolean;
    // Resolves an import against one directory; the rest are Pyright's lookup options.
    protected resolveAbsoluteImport(
      sourceFileUri: Uri | undefined,
      rootPath: Uri,
      execEnv: ExecutionEnvironment,
      moduleDescriptor: ImportedModuleDescriptor,
      ...options: unknown[]
    ): ImportResult | undefined;
    // The import roots in order, then the standard library stubs; private in Pyright's source.
    protected _resolveBestAbsoluteImport(
      sourceFileUri: Uri,
      execEnv: ExecutionEnvironment,
      moduleDescriptor: ImportedModuleDescriptor,
      allowPyi: boolean,
    ): ImportResult | undefined;
  }
}

declare module "pyright-internal/analyzer/program" {
  import type { AnalyzerNodeInfoReader } from "pyright-internal/analyzer/analyzerNodeInfo";
  import type { ImportResolver } from "pyright-internal/analyzer/importResolver";
  import type { TypeEvaluator } from "pyright-internal/analyzer/typeEvaluatorTypes";
  import type { ConfigOptions } from "pyright-internal/common/configOptions";
  import type { Diagnostic } from "pyright-internal/common/diagnostic";
  import type { ServiceProvider } from "pyright-internal/common/serviceProviderExtensions";
  import type { Uri } from "pyright-internal/common/uri/uri";
  import type { ModuleNode } from "pyright-internal/parser/parseNodes";
  export class Program {
    constructor(
      importResolver: ImportResolver,
      configOptions: ConfigOptions,
      serviceProvider: ServiceProvider,
      logTracker?: undefined,
      disableChecker?: boolean,
    );
    readonly evaluator: TypeEvaluator | undefined;
    readonly analyzerNodeInfoReader: AnalyzerNodeInfoReader;
    setTrackedFiles(fileUris: Uri[]): unknown;
    getParseResults(
      fileUri: Uri,
    ): { text: string; parserOutput: { parseTree: ModuleNode } } | undefined;
    getSourceFile(fileUri: Uri): { getParseDiagnostics(): Diagnostic[] } | undefined;
    getBoundSourceFile(fileUri: Uri): unknown;
    dispose(): void;
  }
}
