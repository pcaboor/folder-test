import { db } from '../server/db';
import { GithubRepoLoader } from "@langchain/community/document_loaders/web/github";
import { Document } from "@langchain/core/documents";
import { generateEmbedding, summariseCode } from "./mistral";
import { Octokit } from 'octokit';
import { decryptSensitiveData } from './encrypt';

// File size limit in kilobytes
const FILE_SIZE_LIMIT_KB = 80;

const getFileCount = async (path: string, octokit: Octokit, githubOwner: string, githubRepo: string, acc: number = 0, branch?: string, ignoresFilesExtensions: string[] = []) => {
    const params: any = {
        owner: githubOwner,
        repo: githubRepo,
        path,
    };

    // Only add ref parameter if a branch is specified
    if (branch) {
        params.ref = branch;
    }

    const { data } = await octokit.rest.repos.getContent(params);

    const defaultIgnoredFiles = [
        'package-lock.json',
        'yarn.lock',
        'pnpm-lock.yaml',
        'bun.lockb',
        'node_modules',
        'databases',
        'database',
        '.DS_Store',
        '.gitignore'
    ];

    const allIgnoredFiles = [...defaultIgnoredFiles, ...ignoresFilesExtensions];


    if (!Array.isArray(data) && data.type === "file") {
        // Check if file should be ignored
        const shouldIgnore = allIgnoredFiles.some(ignoredFile =>
            data.name.includes(ignoredFile) ||
            allIgnoredFiles.some(ext => data.name.endsWith(ext))
        );
        return shouldIgnore ? acc : acc + 1;
    }

    if (Array.isArray(data)) {
        let fileCount = 0;
        const directories: string[] = [];

        for (const item of data) {
            // Check if item should be ignored
            const shouldIgnore = allIgnoredFiles.some(ignoredFile =>
                item.name.includes(ignoredFile) ||
                allIgnoredFiles.some(ext => item.name.endsWith(ext))
            );

            if (item.type === "dir" && !shouldIgnore) {
                directories.push(item.path);
            } else if (item.type === "file" && !shouldIgnore) {
                fileCount++;
            }
        }
        if (directories.length > 0) {
            const directoryCounts = await Promise.all(
                directories.map(dirPath =>
                    getFileCount(dirPath, octokit, githubOwner, githubRepo, 0, branch, ignoresFilesExtensions))
            );
            fileCount += directoryCounts.reduce((acc, count) => acc + count, 0);
        }
        return acc + fileCount;
    }

    return acc;
};

export const checkCredits = async (
    userId: string,
    githubUrl?: string,
    githubToken?: string,
    branch?: string,
    ignoresFilesExtensions?: string | string[],
    avatarRepo?: string
) => {
    const cleanUrl = githubUrl?.replace(/\.git$/, '');

    const user = await db.user.findUnique({
        where: { id: userId },
        select: { githubToken: true },
    });

    if (!user || !user.githubToken) {
        throw new Error('GitHub token not found for user.');
    }

    const decryptAccessTokenGithub = decryptSensitiveData(user.githubToken);

    const octokit = new Octokit({
        auth: decryptAccessTokenGithub,
        request: { timeout: 30000 },
    });

    const githubOwner = cleanUrl?.split('/')[3];
    const githubRepo = cleanUrl?.split('/')[4];
    if (!githubOwner || !githubRepo) {
        return 0;
    }

    const normalizedIgnoredExtensions = ignoresFilesExtensions
        ? Array.isArray(ignoresFilesExtensions)
            ? ignoresFilesExtensions
            : [ignoresFilesExtensions]
        : [];


    console.log("NormalizedIgnoredExtensions", normalizedIgnoredExtensions)

    // 🔄 Sinon, on utilise la branche (ou on la récupère)
    let branchToUse = branch;
    if (!branchToUse) {
        try {
            const { data } = await octokit.rest.repos.get({
                owner: githubOwner,
                repo: githubRepo,
            });
            branchToUse = data.default_branch;
            avatarRepo = data.owner.avatar_url;
            console.log("Detected default branch for credits check:", branchToUse);
        } catch (e) {
            console.log("Could not detect default branch, falling back to empty ref");
        }
    }

    // 📂 Calcul récursif des fichiers dans le repo
    const fileCount = await getFileCount('', octokit, githubOwner, githubRepo, 0, branchToUse, normalizedIgnoredExtensions);
    const result =
        fileCount
    return result;
};

export const loadGithubRepo = async (userId?: string, githubUrl?: string, githubToken?: string, branch?: string, ignoreFilesExtensions: string[] = []) => {
    const ignoredFiles = [
        'package-lock.json',
        'yarn.lock',
        'pnpm-lock.yaml',
        'bun.lockb',
        'node_modules',
        'databases',
        'database',
        '.DS_Store',
        '.gitignore',
        ...ignoreFilesExtensions
    ];

    console.log("ignoreFilesExtensions =========>", ignoreFilesExtensions);
    const cleanUrl = githubUrl?.replace(/\.git$/, '');

    try {
        // Try to detect if repo uses main or master as default branch if no branch is specified
        if (!branch) {
            try {
                const user = await db.user.findUnique({
                    where: { id: userId },
                    select: { githubToken: true },
                });

                if (!user || !user.githubToken) {
                    throw new Error('GitHub token not found for user.');
                }

                const decryptAccessTokenGithub = decryptSensitiveData(user?.githubToken)
                const octokit = new Octokit({
                    auth: decryptAccessTokenGithub,
                    request: { timeout: 30000 },
                });

                const githubOwner = cleanUrl?.split('/')[3];
                const githubRepo = cleanUrl?.split('/')[4];

                if (githubOwner && githubRepo) {
                    const { data } = await octokit.rest.repos.get({
                        owner: githubOwner,
                        repo: githubRepo,
                    });
                    branch = data.default_branch; // This gets the default branch from GitHub
                    console.log("Detected default branch:", branch);
                }
            } catch (e) {
                console.log("Could not detect default branch, falling back to 'main'");
                branch = "main"; // Fallback to main if detection fails
            }
        }

        const user = await db.user.findUnique({
            where: { id: userId },
            select: { githubToken: true },
        });

        if (!user || !user.githubToken) {
            throw new Error('GitHub token not found for user.');
        }

        const decryptAccessTokenGithub = decryptSensitiveData(user?.githubToken);
        const octokit = new Octokit({
            auth: decryptAccessTokenGithub,
            request: { timeout: 30000 },
        });

        // Get the repository contents first to check file sizes
        const githubOwner = cleanUrl?.split('/')[3];
        const githubRepo = cleanUrl?.split('/')[4];

        if (!githubOwner || !githubRepo) {
            throw new Error('Invalid GitHub URL');
        }

        // Get all files in the repository and filter out large files
        const FILE_SIZE_LIMIT_KB = 80;
        const allFiles = await getAllFilesInRepo(octokit, githubOwner, githubRepo, branch || 'main');

        // Filter out files that are too large
        const largeFiles = allFiles.filter(file => (file.size / 1024) > FILE_SIZE_LIMIT_KB);

        // Log the large files that will be ignored
        if (largeFiles.length > 0) {
            console.log(`[WARNING] Skipping ${largeFiles.length} files that exceed the 80KB size limit:`);
            largeFiles.forEach(file => {
                console.log(`- ${file.path} (${(file.size / 1024).toFixed(2)}KB)`);
                ignoredFiles.push(file.path); // Add large files to ignored files
            });
        }

        const loader = new GithubRepoLoader(cleanUrl || "", {
            accessToken: decryptAccessTokenGithub,
            branch: branch || "main",
            ignoreFiles: ignoredFiles,
            recursive: true,
            unknown: 'warn',
            maxConcurrency: 2,
        });

        const docs = await loader.load();

        console.log("DOCS loaded", docs);
        return docs;
    } catch (error: any) {
        if (error.response?.status === 404) {
            console.error(`Repository not found or branch "${branch}" does not exist: ${githubUrl}`);
            throw new Error(`Unable to fetch repository files: ${error.response.status} ${error.response.data.message}`);
        }
        if (error.response?.status === 403 && error.response?.headers?.['x-ratelimit-remaining'] === '0') {
            console.error('GitHub API rate limit exceeded. Retry after:', error.response.headers['x-ratelimit-reset']);
            throw new Error('GitHub API rate limit exceeded. Please try again later.');
        } else {
            console.error(`Failed to process repository: ${error.message}`);
            throw new Error(`Unknown error: ${error.message}`);
        }
    }
};

// Helper function to recursively get all files in a repository
async function getAllFilesInRepo(
    octokit: Octokit,
    owner: string,
    repo: string,
    branch: string,
    path: string = ''
): Promise<Array<{ path: string, size: number }>> {
    const result: Array<{ path: string, size: number }> = [];

    try {
        const { data } = await octokit.rest.repos.getContent({
            owner,
            repo,
            path,
            ref: branch
        });

        if (Array.isArray(data)) {
            // Directory - process each item
            for (const item of data) {
                if (item.type === 'file') {
                    result.push({
                        path: item.path,
                        size: item.size
                    });
                } else if (item.type === 'dir') {
                    // Recursively process directories
                    const subFiles = await getAllFilesInRepo(octokit, owner, repo, branch, item.path);
                    result.push(...subFiles);
                }
            }
        } else if (data.type === 'file') {
            // Single file
            result.push({
                path: data.path,
                size: data.size
            });
        }
    } catch (error) {
        console.error(`Error fetching contents of ${path}:`, error);
    }

    return result;
}

export const indexGithubRepo = async (userId: string, projectId: string, githubUrl?: string, githubToken?: string, branch?: string, ignoreFilesExtensions: string[] = []) => {
    try {
        console.log(`[START] Indexing GitHub repo: ${githubUrl}, branch: ${branch || 'default'}`);

        // Charger les documents depuis GitHub
        const docs = await loadGithubRepo(userId, githubUrl, githubToken, branch, ignoreFilesExtensions);
        console.log("DOCS : ==========>" + docs)
        console.log(`[INFO] Loaded ${docs.length} files from repository`);

        console.log(`[INFO] Processing ${docs.length} selected files out of ${docs.length} total files`);

        // Traiter les documents par lots de 10
        const batchSize = 1;
        const batches = [];

        for (let i = 0; i < docs.length; i += batchSize) {
            batches.push(docs.slice(i, i + batchSize));
        }

        console.log(`[INFO] Processing ${batches.length} batches of ${batchSize} files`);

        let processedFiles = 0;

        // Traiter chaque lot séquentiellement
        for (let i = 0; i < batches.length; i++) {

            await db.project.update({
                where: { id: projectId },
                data: { processedFiles: { increment: 1 } }
            });

            const batch = batches[i];
            console.log(`[INFO] Processing batch ${i + 1}/${batches.length}`);

            // Générer les embeddings pour ce lot
            const batchEmbeddings = await generateEmbeddingsForBatch(userId, batch!);

            // Stocker les embeddings en base de données
            await Promise.all(batchEmbeddings.map(async (embedding) => {
                if (!embedding) return;

                try {
                    // Before saving to the database
                    const sourceCode = typeof embedding.sourceCode === 'string'
                        ? embedding.sourceCode.replace(/\0/g, '')
                        : '';
                    let summary = '';
                    if (typeof embedding.summary === 'string') {
                        summary = embedding.summary.replace(/\0/g, '');
                    } else if (Array.isArray(embedding.summary)) {
                        // Convert ContentChunk[] to string if it's an array
                        summary = embedding.summary.map(chunk =>
                            typeof chunk === 'string' ? chunk : JSON.stringify(chunk)
                        ).join(' ').replace(/\0/g, '');
                    }

                    const sourceCodeEmbedding = await db.sourceCodeEmbedding.create({
                        data: {
                            summary: summary,
                            sourceCode: sourceCode,
                            fileName: embedding.fileName || '',
                            projectId,
                        }
                    });
                    await db.$executeRaw`
                    UPDATE "SourceCodeEmbedding"
                    SET "summaryEmbedding" = ${JSON.stringify(embedding.embedding)}::vector
                    WHERE "id" = ${sourceCodeEmbedding.id}
                `;

                    processedFiles++;
                    if (processedFiles % 10 === 0) {
                        console.log(`[INFO] Processed ${processedFiles}/${docs.length} files`);
                    }
                } catch (error) {
                    console.error(`[ERROR] Failed to store embedding for file: ${embedding.fileName}`, error);
                }
            }));

            // Pause entre les lots pour éviter de surcharger les API
            if (i < batches.length - 1) {
                console.log(`[INFO] Pausing for 60 seconds before next batch`);
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }

        console.log(`[COMPLETE] Successfully indexed GitHub repo: ${githubUrl}`);
    } catch (error) {
        console.error(`[FATAL] Failed to index GitHub repo: ${githubUrl}`, error);
        throw error; // Propager l'erreur pour la gestion en amont
    }
};

// Fonction d'aide pour traiter un lot de documents
async function generateEmbeddingsForBatch(userId: string, docs: Document[]) {
    return await Promise.all(docs.map(async doc => {
        try {
            console.log(`[INFO] Processing file: ${doc.metadata.source}`);
            const summary = await summariseCode(userId, doc);
            console.log(`[INFO] Generated summary for: ${doc.metadata.source}`);

            const summaryString = typeof summary === 'string'
                ? summary
                : Array.isArray(summary)
                    ? summary.map(chunk => typeof chunk === 'string' ? chunk : JSON.stringify(chunk)).join(' ')
                    : summary ? String(summary) : '';

            const embedding = await generateEmbedding(userId, summaryString);
            console.log(`[INFO] Generated embedding for: ${doc.metadata.source}`);


            return {
                summary,
                embedding,
                sourceCode: JSON.parse(JSON.stringify(doc.pageContent)),
                fileName: doc.metadata.source
            };
        } catch (error) {
            console.error(`[ERROR] Failed to process file: ${doc.metadata.source}`, error);
            return null;
        }
    }));
}