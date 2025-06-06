const core = require('@actions/core');
const github = require('@actions/github');
const { execSync } = require('child_process');

async function run() {
  try {
    // Get inputs
    const repo = core.getInput('repo', { required: true });
    const token = core.getInput('token', { required: true });
    const applicationName = core.getInput('application_name', { required: true });
    const releaseType = core.getInput('release_type') || '';
    const changeType = core.getInput('change_type', { required: true });

    core.info(`Application: ${applicationName}`);
    core.info(`Release Type: ${releaseType || 'Production'}`);
    core.info(`Change Type: ${changeType}`);

    // Initialize Octokit
    const octokit = github.getOctokit(token);
    const [owner, repoName] = repo.split('/');

    // Check if we're in a git repository, if not, clone it
    try {
      execSync('git rev-parse --git-dir', { stdio: 'pipe' });
      core.info('Already in a git repository');
    } catch (error) {
      core.info('Not in a git repository, cloning...');
      const repoUrl = `https://x-access-token:${token}@github.com/${repo}.git`;
      execSync(`git clone ${repoUrl} .`, { stdio: 'inherit' });
    }

    // Configure Git
    execSync('git config --global user.name "github-actions[bot]"');
    execSync('git config --global user.email "github-actions[bot]@users.noreply.github.com"');

    // Fetch all tags
    core.info('Fetching all repository tags...');
    execSync('git fetch --tags');

    // Get all tags from repository
    const { data: tags } = await octokit.rest.repos.listTags({
      owner,
      repo: repoName,
      per_page: 100
    });

    core.info(`Found ${tags.length} total tags in repository`);

    // Filter tags for this application and release type
    const filteredTags = filterTags(tags, applicationName, releaseType);
    core.info(`Found ${filteredTags.length} matching tags for ${applicationName}${releaseType ? `-${releaseType}` : ''}`);

    // Get current version
    const currentVersion = getCurrentVersion(filteredTags, applicationName, releaseType);
    core.info(`Current version: ${currentVersion}`);

    // Generate new version
    const newVersion = generateNewVersion(currentVersion, changeType);
    core.info(`New version: ${newVersion}`);

    // Create tag names
    const tagVersion = releaseType ? `${newVersion}-${releaseType}` : newVersion;
    const newTag = `${applicationName}/${tagVersion}`;

    core.info(`Tag version: ${tagVersion}`);
    core.info(`Complete new tag: ${newTag}`);

    // Check if tag already exists
    const tagExists = await checkTagExists(octokit, owner, repoName, newTag);
    if (tagExists) {
      throw new Error(`Tag ${newTag} already exists!`);
    }

    // Create and push the tag
    await createAndPushTag(newTag, tagVersion);

    // Set outputs
    core.setOutput('tag_version', tagVersion);
    core.setOutput('new_tag', newTag);

    // Summary
    core.summary
      .addHeading('🎉 Version Update Summary')
      .addTable([
        [{ data: 'Property', header: true }, { data: 'Value', header: true }],
        ['Application', applicationName],
        ['Change Type', changeType],
        ['Release Type', releaseType || 'Production'],
        ['New Tag', newTag],
        ['Tag Version', tagVersion]
      ])
      .write();

    core.info('✅ Successfully created and pushed new version tag!');

  } catch (error) {
    core.setFailed(`Action failed: ${error.message}`);
  }
}

function filterTags(tags, applicationName, releaseType) {
  const prefix = `${applicationName}/V`;
  const suffix = releaseType ? `-${releaseType}` : '';

  return tags.filter(tag => {
    const tagName = tag.name;
    
    // Must start with application prefix
    if (!tagName.startsWith(prefix)) {
      return false;
    }

    // For production releases (no release type)
    if (!releaseType) {
      // Should not have any release type suffix
      const versionPart = tagName.substring(prefix.length);
      return !versionPart.includes('-');
    }

    // For specific release types
    return tagName.endsWith(suffix);
  });
}

function getCurrentVersion(filteredTags, applicationName, releaseType) {
  if (filteredTags.length === 0) {
    core.info('No matching tags found, starting from V1.0.0');
    return 'V1.0.0';
  }

  // Sort tags by version (semantic versioning)
  const sortedTags = filteredTags.sort((a, b) => {
    const versionA = extractVersionNumbers(a.name, applicationName, releaseType);
    const versionB = extractVersionNumbers(b.name, applicationName, releaseType);
    
    return compareVersions(versionA, versionB);
  });

  const latestTag = sortedTags[sortedTags.length - 1];
  core.info(`Latest matching tag: ${latestTag.name}`);

  // Extract version from tag
  const prefix = `${applicationName}/`;
  const suffix = releaseType ? `-${releaseType}` : '';
  
  let version = latestTag.name.substring(prefix.length);
  if (suffix) {
    version = version.replace(suffix, '');
  }

  return version;
}

function extractVersionNumbers(tagName, applicationName, releaseType) {
  const prefix = `${applicationName}/`;
  const suffix = releaseType ? `-${releaseType}` : '';
  
  let version = tagName.substring(prefix.length);
  if (suffix) {
    version = version.replace(suffix, '');
  }
  
  // Remove 'V' prefix and split
  const numbers = version.substring(1).split('.').map(n => parseInt(n) || 0);
  return {
    major: numbers[0] || 0,
    minor: numbers[1] || 0,
    patch: numbers[2] || 0
  };
}

function compareVersions(a, b) {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

function generateNewVersion(currentVersion, changeType) {
  // Extract version numbers (remove 'V' prefix)
  const versionNumbers = currentVersion.substring(1);
  const [major, minor, patch] = versionNumbers.split('.').map(n => parseInt(n) || 0);

  core.info(`Current version parts: Major=${major}, Minor=${minor}, Patch=${patch}`);

  let newMajor = major;
  let newMinor = minor;
  let newPatch = patch;

  switch (changeType.toLowerCase()) {
    case 'major':
      newMajor = major + 1;
      newMinor = 0;
      newPatch = 0;
      break;
    case 'minor':
      newMinor = minor + 1;
      newPatch = 0;
      break;
    case 'patch':
      newPatch = patch + 1;
      break;
    default:
      throw new Error(`Invalid change_type: ${changeType}. Must be 'major', 'minor', or 'patch'`);
  }

  const newVersion = `V${newMajor}.${newMinor}.${newPatch}`;
  core.info(`New version parts: Major=${newMajor}, Minor=${newMinor}, Patch=${newPatch}`);
  
  return newVersion;
}

async function checkTagExists(octokit, owner, repo, tagName) {
  try {
    await octokit.rest.git.getRef({
      owner,
      repo,
      ref: `tags/${tagName}`
    });
    return true;
  } catch (error) {
    if (error.status === 404) {
      return false;
    }
    throw error;
  }
}

async function createAndPushTag(newTag, tagVersion) {
  core.info(`Creating tag: ${newTag}`);
  
  try {
    // Create annotated tag
    execSync(`git tag -a "${newTag}" -m "Release ${tagVersion}"`, { stdio: 'inherit' });
    
    // Push the tag
    execSync(`git push origin "${newTag}"`, { stdio: 'inherit' });
    
    core.info(`Successfully created and pushed tag: ${newTag}`);
  } catch (error) {
    throw new Error(`Failed to create/push tag: ${error.message}`);
  }
}

// Run the action
run();