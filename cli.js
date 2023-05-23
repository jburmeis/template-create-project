#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const util = require('util');
const readline = require('node:readline/promises');
const exec = util.promisify(require('child_process').exec);


// Configure console IO interface
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

rl.on("close", function () {
    process.exit(0);
});

/*********************************************************************
 *  Script Entrypoint
 ********************************************************************/
main().then(() => process.exit())

async function main() {
    // Fetch templates from GitHub
    const templates = await userInterfaceLoadTemplates();

    // Run user interface
    await userInterface(templates);
}

/*********************************************************************
 *  User Interface
 ********************************************************************/
async function userInterfaceLoadTemplates() {
    console.log("Fetching available project templates...");
    const templates = await fetchAvailableTemplates();
    if (templates.length === 0) {
        console.log("No project templates available");
        return;
    }
    console.clear();
    return templates;
}

async function userInterface(templates) {
    // This structure will be filled in the UI part
    const projectSetup = {
        template: "",
        id: "",
        name: "",
        userName: "",
        userEmail: "",
    }

    // Question project template
    printAvailableTemplates(templates);
    const templateIdx = Number.parseInt(await rl.question("Select project template (type index number): "));
    if (!Number.isInteger(templateIdx) || templateIdx < 0 || templateIdx >= templates.length) {
        console.error("Invalid input - Expected valid template index");
        process.exit(9);
    }
    projectSetup.template = templates[templateIdx];

    // Question project name
    projectSetup.name = (await rl.question("Enter project name: ")).trim();
    if (projectSetup.name.length === 0) {
        console.error("Invalid input - Expected non-empty project name");
        process.exit(9);
    }
    projectSetup.id = convertStringToProjectId(projectSetup.name);

    // Read current user name, email
    const { gitName, gitEmail } = await getCurrentUserInfo();
    projectSetup.userName = gitName;
    projectSetup.userEmail = gitEmail;

    // Question summary
    console.clear();
    await rl.question(getSummaryString(projectSetup));

    // Start project creation
    console.clear();
    await createProject(projectSetup);

    rl.close();
}

function printAvailableTemplates(templates) {
    console.log("Available project templates: ");
    for (let i = 0; i < templates.length; i++) {
        const template = templates[i];
        console.log(`\x1b[94m[${i}] ${template["name"]} \x1b[0m`);
        console.log(`    ${template["description"]}\n`);
    }
}

function getSummaryString(projectSetup) {
    return `Confirm new project:
Project ID:    \x1b[94m${projectSetup.id}\x1b[0m
Project Name:  \x1b[94m${projectSetup.name}\x1b[0m
Project Type:  \x1b[94m${projectSetup.template.name}\x1b[0m
User Name:     \x1b[94m${projectSetup.userName}\x1b[0m
User Email:    \x1b[94m${projectSetup.userEmail}\x1b[0m
Location:      \x1b[94m${getProjectTargetDirectory(projectSetup)}\x1b[0m
Continue and create project (Enter)?\n`;
}

/*********************************************************************
 *  Create Project
 ********************************************************************/
async function createProject(projectSetup) {
    const workingDir = getProjectTargetDirectory(projectSetup);

    try {
        checkAvailabilityOfDirectory(projectSetup.id);

        console.log(`Downloading template...`);
        await downloadProjectTemplateData(workingDir, projectSetup.template.gitUrl);

        console.log(`Filtering...`);
        await filterFiles(workingDir, projectSetup);

        console.log("Cleanup...");
        await removeTemplateFiles(workingDir);

        console.log(`\nYour project has been created. Please consult the README file how to proceed from here.`);
    } catch (error) {
        console.error(error.message);
        process.exit(9);
    }
}

async function downloadProjectTemplateData(targetDirectory, templateGitUrl) {
    try {
        return exec(`git clone --depth 1 ${templateGitUrl} "${targetDirectory}"`);
    } catch (error) {
        console.error("Error in connection with the template repository");
        process.exit(9);
    }
}

async function filterFiles(dir, projectSetup) {
    const configFile = JSON.parse(fs.readFileSync(path.resolve(dir, "__template.json")));
    const filePromises = configFile["project"].map(fileEntry => filterFile(fileEntry, dir, projectSetup));
    return Promise.allSettled(filePromises);
}

async function filterFile(fileConfig, dir, projectSetup) {
    const filepath = path.resolve(dir, fileConfig.file);
    let fileData = await fs.promises.readFile(filepath);
    for (const key of fileConfig.keywords) {
        switch (key) {
            case "webstart-project-id":
                fileData = fileData.toString().replaceAll(key, `${projectSetup.id}`);
                break;
            case "webstart-project-name":
                fileData = fileData.toString().replaceAll(key, `${projectSetup.name}`);
                break;
            case "webstart-project-author":
                fileData = fileData.toString().replaceAll(key, `${projectSetup.userName} <${projectSetup.userEmail}>`);
                break;
            case "webstart-project-setupdate":
                fileData = fileData.toString().replaceAll(key, `${new Date().toLocaleDateString("en-US")} (en-US)`);
                break;
            case "webstart-template-url":
                fileData = fileData.toString().replaceAll(key, `${projectSetup.template.htmlUrl}`);
                break;
            case "@webstart":
                fileData = fileData.toString().replaceAll(key, `@${projectSetup.id}`);
                break;
        }
    }
    return fs.promises.writeFile(filepath, fileData);
}

async function removeTemplateFiles(filepath) {
    return Promise.allSettled([
        fs.promises.unlink(path.resolve(filepath, "__template.json")),
        fs.promises.unlink(path.resolve(filepath, "LICENSE")),
        fs.promises.rm(path.resolve(filepath, ".git"), { recursive: true }),
    ])
}

async function fetchAvailableTemplates() {
    const query = encodeURIComponent("user:jburmeis project-template in:topics");
    const url = `https://api.github.com/search/repositories?q=${query}`;

    const response = await (await fetch(url)).json();
    const templates = response.items.map(item => ({
        name: item["name"],
        description: item["description"],
        htmlUrl: item["html_url"],
        gitUrl: item["clone_url"],
    }));

    return templates;
}

/*********************************************************************
 *  Utility Functions
 ********************************************************************/

function convertStringToProjectId(projectName) {
    let splits = projectName.trim().split(/\s+/);
    splits = splits.map(split => split.toLowerCase());

    return splits.join('-');
}

function checkAvailabilityOfDirectory(targetDirectory) {
    if (fs.existsSync(targetDirectory)) {
        throw new Error(`Target directory '${targetDirectory}' already exists'`);
    }
}

function getProjectTargetDirectory(projectSetup) {
    return path.join(process.cwd(), projectSetup.id);
}

async function getCurrentUserInfo() {
    try {
        return {
            gitName: (await executeShell("git config user.name")).replace("\n", ""),
            gitEmail: (await executeShell("git config user.email")).replace("\n", "")
        }
    } catch {
        return {
            gitName: "Unknown",
            gitEmail: ""
        }
    }
}

function executeShell(command) {
    return new Promise((resolve, reject) => {
        exec(command, (error, stdout, stderr) => {
            if (error) {
                console.error(error);
                reject(error);
            }
            resolve(stdout);
        });
    });
}
