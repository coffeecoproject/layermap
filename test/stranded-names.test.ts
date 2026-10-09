import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { test } from "node:test";
import { promisify } from "node:util";
import { openMap, project, signal } from "./support";

const run = promisify(execFile);

// Environment variables and configuration keys are linked by name only: renaming one side leaves
// the other reading or setting the old name, and the check names those places.
async function checkAfter(
  files: Record<string, string>,
  changes: Record<string, string>,
): Promise<string> {
  const { root, write } = await project(files);
  await run("git", ["add", "-A"], { cwd: root });
  await run("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base"], {
    cwd: root,
  });
  const map = await openMap(root);
  try {
    for (const [file, content] of Object.entries(changes)) await write(file, content);
    return (await map.checkChanges({}, signal())).text;
  } finally {
    map.close();
  }
}

const SECTION = "NAMES STILL USED ELSEWHERE";
// A ${NAME} placeholder as configuration files write it.
const ref = (inner: string) => `\${${inner}}`;
const section = (text: string) =>
  text.includes(SECTION)
    ? text.slice(text.indexOf(SECTION), text.indexOf("\n", text.indexOf("These places")))
    : "";

test("an environment variable renamed in code is named where configuration still sets it", async () => {
  const settings = (name: string) =>
    `import os\n\n\ndef database_url():\n    return os.environ.get("${name}")\n`;
  const level = (name: string) =>
    `package logs\n\nimport "os"\n\nfunc Level() string {\n\treturn os.Getenv("${name}")\n}\n`;
  const text = await checkAfter(
    {
      "go.mod": "module example.com/m\n\ngo 1.22\n",
      "app/__init__.py": "",
      "app/settings.py": settings("DATABASE_URL"),
      "logs/logs.go": level("LOG_LEVEL"),
      ".env.example": "DATABASE_URL=postgres://localhost/app\nLOG_LEVEL=info\n",
      "docker-compose.yml":
        "services:\n  app:\n    environment:\n      DATABASE_URL: postgres://db/app\n      - LOG_LEVEL=debug\n",
      "CHANGELOG.md": "- Read DATABASE_URL and LOG_LEVEL\n",
    },
    { "app/settings.py": settings("DB_URL"), "logs/logs.go": level("LOGS_LEVEL") },
  );
  const names = section(text);
  assert.match(
    names,
    /^ {2}DATABASE_URL, gone from app\/settings\.py: \.env\.example:1, docker-compose\.yml:4$/mu,
  );
  assert.match(
    names,
    /^ {2}LOG_LEVEL, gone from logs\/logs\.go: \.env\.example:2, docker-compose\.yml:5$/mu,
  );
  assert.doesNotMatch(names, /CHANGELOG/u);
  assert.match(text, /update them too or keep the old name working/u);
});

test("a configuration key renamed in its file is named where code still reads it", async () => {
  const text = await checkAfter(
    {
      "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true }, include: ["src"] }),
      "config/app.yaml": "client:\n  retries: 3\n  timeout_ms: 500\n",
      "config/other.yaml": "worker:\n  retries: 1\n",
      "src/client.ts":
        'declare const config: { get(key: string): number };\n\nexport function retries(): number {\n  return config.get("retries");\n}\n\nexport function retriesLeft(retries: number): number {\n  return retries - 1;\n}\n',
    },
    { "config/app.yaml": "client:\n  max_retries: 3\n  timeout_ms: 500\n" },
  );
  const names = section(text);
  assert.match(names, /^ {2}retries, gone from config\/app\.yaml: src\/client\.ts:4$/mu);
  // A plain word elsewhere in configuration, and code using it as a variable, are not reads of it.
  assert.doesNotMatch(names, /other\.yaml|client\.ts:7/u);
});

test("an emptied .env, a properties placeholder and a settings field are each looked up", async () => {
  const settings = (name: string) =>
    `from pydantic_settings import BaseSettings\n\n\nclass Settings(BaseSettings):\n    ${name}: str = "localhost"\n`;
  const text = await checkAfter(
    {
      "app/__init__.py": "",
      "app/config.py": settings("SMTP_HOST"),
      ".env": "API_KEY=secret\n",
      "src/main/resources/application.properties": `spring.datasource.url=${ref("DB_URL:jdbc:h2:mem:db")}\n`,
      "compose.yml": `services:\n  app:\n    environment:\n      API_KEY: ${ref("API_KEY")}\n      DB_URL: jdbc:postgresql://db/app\n      SMTP_HOST: mail\n`,
    },
    {
      "app/config.py": settings("MAIL_HOST"),
      ".env": "",
      "src/main/resources/application.properties": `spring.datasource.url=${ref("DATABASE_URL:jdbc:h2:mem:db")}\n`,
    },
  );
  const names = section(text);
  assert.match(names, /^ {2}SMTP_HOST, gone from app\/config\.py: compose\.yml:6$/mu);
  assert.match(names, /^ {2}API_KEY, gone from \.env: compose\.yml:4$/mu);
  assert.match(
    names,
    /^ {2}DB_URL, gone from src\/main\/resources\/application\.properties: compose\.yml:5$/mu,
  );
});

test("a name moved to another file, or renamed everywhere, is not reported", async () => {
  const text = await checkAfter(
    {
      "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true }, include: ["src"] }),
      "src/a.ts": "export const token = () => process.env.API_TOKEN;\n",
      "src/b.ts": "export const other = () => 1;\n",
      "src/c.ts": "export const region = () => process.env.AWS_REGION;\n",
      ".env.example": "API_TOKEN=x\nAWS_REGION=eu-west-1\n",
    },
    {
      "src/a.ts": "export const none = () => 0;\n",
      "src/b.ts": "export const token = () => process.env.API_TOKEN;\n",
      "src/c.ts": "export const region = () => process.env.CLOUD_REGION;\n",
      ".env.example": "API_TOKEN=x\nCLOUD_REGION=eu-west-1\n",
    },
  );
  assert.doesNotMatch(text, new RegExp(SECTION, "u"));
});
