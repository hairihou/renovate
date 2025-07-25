import { GlobalConfig } from '../../../config/global';
import { logger } from '../../../logger';
import { ExternalHostError } from '../../../types/errors/external-host-error';
import * as memCache from '../../cache/memory';
import * as packageCache from '../../cache/package';
import type { PackageCacheNamespace } from '../../cache/package/types';
import type {
  GithubGraphqlResponse,
  GithubHttp,
  GithubHttpOptions,
} from '../../http/github';
import type { HttpResponse } from '../../http/types';
import { getApiBaseUrl } from '../url';
import { GithubGraphqlMemoryCacheStrategy } from './cache-strategies/memory-cache-strategy';
import { GithubGraphqlPackageCacheStrategy } from './cache-strategies/package-cache-strategy';
import type {
  GithubDatasourceItem,
  GithubGraphqlCacheStrategy,
  GithubGraphqlDatasourceAdapter,
  GithubGraphqlPayload,
  GithubGraphqlRepoParams,
  GithubGraphqlRepoResponse,
  GithubPackageConfig,
  RawQueryResponse,
} from './types';

/**
 * We know empirically that certain type of GraphQL errors
 * can be fixed by shrinking page size.
 *
 * @see https://github.com/renovatebot/renovate/issues/16343
 */
function isUnknownGraphqlError(err: Error): boolean {
  const { message } = err;
  return message.startsWith('Something went wrong while executing your query.');
}

function canBeSolvedByShrinking(err: Error): boolean {
  const errors: Error[] = err instanceof AggregateError ? err.errors : [err];
  return errors.some(
    (e) => err instanceof ExternalHostError || isUnknownGraphqlError(e),
  );
}

export class GithubGraphqlDatasourceFetcher<
  GraphqlItem,
  ResultItem extends GithubDatasourceItem,
> {
  static async query<T, U extends GithubDatasourceItem>(
    config: GithubPackageConfig,
    http: GithubHttp,
    adapter: GithubGraphqlDatasourceAdapter<T, U>,
  ): Promise<U[]> {
    const instance = new GithubGraphqlDatasourceFetcher<T, U>(
      config,
      http,
      adapter,
    );
    const items = await instance.getItems();
    return items;
  }

  private readonly baseUrl: string;
  private readonly repoOwner: string;
  private readonly repoName: string;

  private itemsPerQuery: 100 | 50 | 25 = 100;

  private queryCount = 0;

  private cursor: string | null = null;

  private isPersistent: boolean | undefined;

  constructor(
    packageConfig: GithubPackageConfig,
    private http: GithubHttp,
    private datasourceAdapter: GithubGraphqlDatasourceAdapter<
      GraphqlItem,
      ResultItem
    >,
  ) {
    const { packageName, registryUrl } = packageConfig;
    [this.repoOwner, this.repoName] = packageName.split('/');
    this.baseUrl = getApiBaseUrl(registryUrl).replace(/\/v3\/$/, '/'); // Replace for GHE
  }

  private getCacheNs(): PackageCacheNamespace {
    return this.datasourceAdapter.key;
  }

  private getCacheKey(): string {
    return [this.baseUrl, this.repoOwner, this.repoName].join(':');
  }

  private getRawQueryOptions(): GithubHttpOptions {
    const baseUrl = this.baseUrl;
    const repository = `${this.repoOwner}/${this.repoName}`;
    const query = this.datasourceAdapter.query;
    const variables: GithubGraphqlRepoParams = {
      owner: this.repoOwner,
      name: this.repoName,
      count: this.itemsPerQuery,
      cursor: this.cursor,
    };

    return {
      baseUrl,
      repository,
      readOnly: true,
      body: { query, variables },
    };
  }

  private async doRawQuery(): Promise<
    RawQueryResponse<GithubGraphqlPayload<GraphqlItem>>
  > {
    const requestOptions = this.getRawQueryOptions();

    type GraphqlData = GithubGraphqlRepoResponse<GraphqlItem>;
    type HttpBody = GithubGraphqlResponse<GraphqlData>;
    let httpRes: HttpResponse<HttpBody>;
    try {
      httpRes = await this.http.postJson<HttpBody>('/graphql', requestOptions);
    } catch (err) {
      return [null, err];
    }

    const { body } = httpRes;
    const { data, errors } = body;

    if (errors?.length) {
      if (errors.length === 1) {
        const { message } = errors[0];
        const err = new Error(message);
        return [null, err];
      } else {
        const errorInstances = errors.map(({ message }) => new Error(message));
        const err = new AggregateError(errorInstances);
        return [null, err];
      }
    }

    if (!data) {
      const msg = 'GitHub GraphQL datasource: failed to obtain data';
      const err = new Error(msg);
      return [null, err];
    }

    if (!data.repository) {
      const msg = 'GitHub GraphQL datasource: failed to obtain repository data';
      const err = new Error(msg);
      return [null, err];
    }

    if (!data.repository.payload) {
      const msg =
        'GitHub GraphQL datasource: failed to obtain repository payload data';
      const err = new Error(msg);
      return [null, err];
    }

    this.queryCount += 1;

    // For values other than explicit `false`,
    // we assume that items can not be cached.
    this.isPersistent ??= data.repository.isRepoPrivate === false;

    const res = data.repository.payload;
    return [res, null];
  }

  private shrinkPageSize(): boolean {
    if (this.itemsPerQuery === 100) {
      this.itemsPerQuery = 50;
      return true;
    }

    if (this.itemsPerQuery === 50) {
      this.itemsPerQuery = 25;
      return true;
    }

    return false;
  }

  private hasReachedQueryLimit(): boolean {
    return this.queryCount >= 100;
  }

  private async doShrinkableQuery(): Promise<
    GithubGraphqlPayload<GraphqlItem>
  > {
    let res: GithubGraphqlPayload<GraphqlItem> | null = null;
    let err: Error | null = null;

    while (!res) {
      [res, err] = await this.doRawQuery();
      if (err) {
        if (!canBeSolvedByShrinking(err)) {
          throw err;
        }

        const shrinkResult = this.shrinkPageSize();
        if (!shrinkResult) {
          throw err;
        }
        const { body, ...options } = this.getRawQueryOptions();
        logger.debug(
          { options, newSize: this.itemsPerQuery },
          'Shrinking GitHub GraphQL page size after error',
        );
      }
    }

    return res;
  }

  private _cacheStrategy: GithubGraphqlCacheStrategy<ResultItem> | undefined;

  private cacheStrategy(): GithubGraphqlCacheStrategy<ResultItem> {
    if (this._cacheStrategy) {
      return this._cacheStrategy;
    }
    const cacheNs = this.getCacheNs();
    const cacheKey = this.getCacheKey();
    const cachePrivatePackages = GlobalConfig.get(
      'cachePrivatePackages',
      false,
    );
    this._cacheStrategy =
      cachePrivatePackages || this.isPersistent
        ? new GithubGraphqlPackageCacheStrategy<ResultItem>(cacheNs, cacheKey)
        : new GithubGraphqlMemoryCacheStrategy<ResultItem>(cacheNs, cacheKey);
    return this._cacheStrategy;
  }

  /**
   * This method is responsible for data synchronization.
   * It also detects persistence of the package, based on the first page result.
   */
  private async doPaginatedFetch(): Promise<void> {
    let hasNextPage = true;
    let isPaginationDone = false;
    let nextCursor: string | undefined;
    while (hasNextPage && !isPaginationDone && !this.hasReachedQueryLimit()) {
      const queryResult = await this.doShrinkableQuery();

      const resultItems: ResultItem[] = [];
      for (const node of queryResult.nodes) {
        const item = this.datasourceAdapter.transform(node);
        if (!item) {
          logger.once.info(
            {
              packageName: `${this.repoOwner}/${this.repoName}`,
              baseUrl: this.baseUrl,
            },
            `GitHub GraphQL datasource: skipping empty item`,
          );
          continue;
        }
        resultItems.push(item);
      }

      // It's important to call `getCacheStrategy()` after `doShrinkableQuery()`
      // because `doShrinkableQuery()` may change `this.isCacheable`.
      //
      // Otherwise, cache items for public packages will never be persisted
      // in long-term cache.
      isPaginationDone = await this.cacheStrategy().reconcile(resultItems);

      hasNextPage = !!queryResult?.pageInfo?.hasNextPage;
      nextCursor = queryResult?.pageInfo?.endCursor;
      if (hasNextPage && nextCursor) {
        this.cursor = nextCursor;
      }
    }

    if (this.isPersistent) {
      await this.storePersistenceFlag(30);
    }
  }

  private async doCachedQuery(): Promise<ResultItem[]> {
    await this.loadPersistenceFlag();
    if (!this.isPersistent) {
      await this.doPaginatedFetch();
    }

    const res = await this.cacheStrategy().finalizeAndReturn();
    if (res.length) {
      return res;
    }

    delete this.isPersistent;
    await this.doPaginatedFetch();
    return this.cacheStrategy().finalizeAndReturn();
  }

  async loadPersistenceFlag(): Promise<void> {
    const ns = this.getCacheNs();
    const key = `${this.getCacheKey()}:is-persistent`;
    this.isPersistent = await packageCache.get<true>(ns, key);
  }

  async storePersistenceFlag(minutes: number): Promise<void> {
    const ns = this.getCacheNs();
    const key = `${this.getCacheKey()}:is-persistent`;
    await packageCache.set(ns, key, true, minutes);
  }

  /**
   * This method ensures the only one query is executed
   * to a particular package during single run.
   */
  private doUniqueQuery(): Promise<ResultItem[]> {
    const cacheKey = `github-pending:${this.getCacheNs()}:${this.getCacheKey()}`;
    const resultPromise =
      memCache.get<Promise<ResultItem[]>>(cacheKey) ?? this.doCachedQuery();
    memCache.set(cacheKey, resultPromise);
    return resultPromise;
  }

  async getItems(): Promise<ResultItem[]> {
    const res = await this.doUniqueQuery();
    return res;
  }
}
