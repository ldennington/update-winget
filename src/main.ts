import * as core from '@actions/core';
import { ManifestRepo } from './winget';
import { Repository, Commit, PullRequest, ReleaseAsset } from './git';
import { Version } from './version';
import { GitHub } from '@actions/github';
import { computeSha256Async } from './hash';

function formatMessage(
  format: string,
  id: string,
  filePath: string,
  version: Version
): string {
  return version
    .format(format)
    .replace(/{{id}}/g, id)
    .replace(/{{file}}/g, filePath);
}

async function run(): Promise<void> {
  try {
    const token = core.getInput('token');
    const gitHub = new GitHub(token);

    const repoStr = core.getInput('repo') || 'microsoft/winget-pkgs';
    const repoBranch = core.getInput('branch');
    const manifestRepo = await ManifestRepo.createAsync(
      gitHub,
      repoStr,
      repoBranch
    );

    const id = core.getInput('id', { required: true });
    let manifestText = core.getInput('manifestText', { required: true });
    const versionStr = core.getInput('version');
    let sha256 = core.getInput('sha256');
    const url = core.getInput('url');
    const message = core.getInput('message');
    const releaseRepo =
      core.getInput('releaseRepo') || process.env.GITHUB_REPOSITORY!;
    const releaseTag = core.getInput('releaseTag') || process.env.GITHUB_REF!;
    const releaseAsset = core.getInput('releaseAsset');
    const alwaysUsePullRequest =
      core.getInput('alwaysUsePullRequest') === 'true';

    console.log(`repo=${repoStr}`);
    console.log(`repoBranch=${repoBranch}`);
    console.log(`id=${id}`);
    console.log(`manifestText=${manifestText}`);
    console.log(`version=${versionStr}`);
    console.log(`sha256=${sha256}`);
    console.log(`url=${url}`);
    console.log(`message=${message}`);
    console.log(`releaseRepo=${releaseRepo}`);
    console.log(`releaseTag=${releaseTag}`);
    console.log(`releaseAsset=${releaseAsset}`);
    console.log(`alwaysUsePullRequest=${alwaysUsePullRequest}`);

    console.log(
      `process.env.GITHUB_REPOSITORY=${process.env.GITHUB_REPOSITORY}`
    );
    console.log(`process.env.GITHUB_REF=${process.env.GITHUB_REF}`);

    if (!versionStr && !releaseAsset) {
      throw new Error(
        "must specify either the 'version' parameter OR 'releaseAsset' parameters."
      );
    }

    if (versionStr && releaseAsset) {
      core.error(
        "'version' parameter specified as well as 'releaseAsset' parameter; using 'version' parameter only"
      );
    }

    let asset: ReleaseAsset | undefined;
    let version: Version;
    let fullUrl: string;

    console.log('locate asset if we need to compute either the version or url');
    if (!versionStr || !url) {
      console.log(
        `locating release asset in repo '${releaseRepo}' @ '${releaseTag}'`
      );
      const repoName = Repository.splitRepoName(releaseRepo);
      const sourceRepo = await Repository.createAsync(
        gitHub,
        repoName.owner,
        repoName.repoName
      );
      const assets = await sourceRepo.getReleaseAssetsAsync(releaseTag);
      const nameRegex = new RegExp(releaseAsset);
      asset = assets.find(x => nameRegex.test(x.name));
      if (!asset) {
        throw new Error(
          `unable to find an asset matching '${releaseAsset}' in repo '${releaseRepo}'`
        );
      }
    }

    console.log('locate asset if we need to compute either the version or url');
    if (versionStr) {
      version = new Version(versionStr);
    } else {
      // compute the version from the asset
      if (!asset) {
        throw new Error('missing asset to compute version number from');
      }

      console.log(
        `computing new manifest version number from asset in repo '${releaseRepo}' @ '${releaseTag}'`
      );

      const nameRegex = new RegExp(releaseAsset);
      const matches = asset.name.match(nameRegex);
      if (!matches || matches.length < 2) {
        throw new Error(
          `unable to match at least one capture group in asset name '${asset.name}' with regular expression '${nameRegex}'`
        );
      }

      if (matches.groups?.version) {
        console.log(
          `using 'version' named capture group for new package version: ${matches.groups?.version}`
        );
        version = new Version(matches.groups.version);
      } else {
        console.log(
          `using first capture group for new package version: ${matches[1]}`
        );
        version = new Version(matches[1]);
      }
    }

    if (url) {
      // if we have an explicit url, format and use that
      fullUrl = version.format(url);
    } else {
      // use the download URL of the asset
      if (!asset) {
        throw new Error('missing asset to compute URL from');
      }

      console.log(
        `computing new manifest URL from asset in repo '${releaseRepo}' @ '${releaseTag}'`
      );

      fullUrl = asset.downloadUrl;
    }

    // if we have an explicit sha256 checksum, use that!
    // otherwise compute it from the download URL
    if (!sha256) {
      if (!fullUrl) {
        throw new Error('missing URL to compute checksum from');
      }

      console.log(`computing SHA256 hash of data from asset at '${fullUrl}'...`);

      sha256 = await computeSha256Async(fullUrl);
      console.log(`sha256=${sha256}`);
    }

    console.log('generating manifest...');

    console.log('setting id...');
    manifestText = manifestText.replace('{{id}}', id);

    console.log('setting sha256...');
    manifestText = manifestText.replace('{{sha256}}', sha256);

    console.log('setting url...');
    manifestText = manifestText.replace('{{url}}', fullUrl);

    console.log('setting version...');
    manifestText = manifestText.replace('{{version}}', version.toString());
    manifestText = manifestText.replace(
      '{{version.major}}',
      version.toString(1)
    );
    manifestText = manifestText.replace(
      '{{version.major_minor}}',
      version.toString(2)
    );
    manifestText = manifestText.replace(
      '{{version.major_minor_patch}}',
      version.toString(3)
    );

    console.log('computing manifest file path...');
    const manifestFilePath = `manifests/${id.replace(
      '.',
      '/'
    )}/${version}.yaml`;
    console.log(`manifest file path is: ${manifestFilePath}`);

    console.log(`final manifest is:`);
    console.log(manifestText);

    const fullMessage = formatMessage(message, id, manifestFilePath, version);

    console.log('publishing manifest...');
    const uploadOptions = {
      manifest: manifestText,
      filePath: manifestFilePath,
      message: fullMessage,
      alwaysUsePullRequest
    };
    const result = await manifestRepo.uploadManifestAsync(uploadOptions);
    if (result instanceof Commit) {
      console.log(`Created commit '${result.sha}': ${result.url}`);
    } else if (result instanceof PullRequest) {
      console.log(`Created pull request '${result.id}': ${result.url}`);
    } else {
      console.log('unknown type of package update');
    }
  } catch (error) {
    core.setFailed(error.message);
  }
}

run();
