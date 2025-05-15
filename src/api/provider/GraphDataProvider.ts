import { MapillaryError } from "../../error/MapillaryError";
import {
    decompress,
    fetchArrayBuffer,
    readMeshPbf,
    xhrFetch,
    XMLHttpRequestHeader,
} from "../Common";
import { ClusterContract } from "../contracts/ClusterContract";
import { CoreImagesContract } from "../contracts/CoreImagesContract";
import { EntContract } from "../contracts/EntContract";
import { ImagesContract } from "../contracts/ImagesContract";
import { ImageTilesContract } from "../contracts/ImageTilesContract";
import { ImageTilesRequestContract } from "../contracts/ImageTilesRequestContract";
import { MeshContract } from "../contracts/MeshContract";
import { SequenceContract } from "../contracts/SequenceContract";
import { SpatialImagesContract } from "../contracts/SpatialImagesContract";
import { DataProviderBase } from "../DataProviderBase";
import { IDEnt } from "../ents/IDEnt";
import { ImageEnt } from "../ents/ImageEnt";
import { ImageTileEnt } from "../ents/ImageTileEnt";
import { SpatialImageEnt } from "../ents/SpatialImageEnt";
import { IGeometryProvider } from "../interfaces/IGeometryProvider";
import { S2GeometryProvider } from "../S2GeometryProvider";
import {
    GraphClusterContract,
    GraphContract,
    GraphError,
} from "./GraphContracts";
import { GraphConverter, MeshParameters } from "./GraphConverter";
import { GraphDataProviderOptions } from "./GraphDataProviderOptions";
import {
    GraphCoreImageEnt,
    GraphImageEnt,
    GraphSpatialImageEnt,
} from "./GraphEnts";
import { GraphQueryCreator } from "./GraphQueryCreator";

export class GraphDataProvider extends DataProviderBase {
    private readonly _method: "GET";
    private readonly _endpoint: string;
    private readonly _cache: Map<string, any>;
    private readonly _cacheTimeout: number;

    private readonly _convert: GraphConverter;
    private readonly _query: GraphQueryCreator;
    private readonly _meshParameters: Map<string, MeshParameters>;

    private _accessToken: string | undefined;

    constructor(
        options?: GraphDataProviderOptions,
        geometry?: IGeometryProvider,
        converter?: GraphConverter,
        queryCreator?: GraphQueryCreator
    ) {
        super(geometry ?? new S2GeometryProvider());

        this._convert = converter ?? new GraphConverter();
        this._query = queryCreator ?? new GraphQueryCreator();
        this._meshParameters = new Map();

        this._method = "GET";
        const opts = options ?? {};
        this._endpoint = opts.endpoint ?? "https://graph.mapillary.com";
        this._accessToken = opts.accessToken;

        this._cache = new Map();
        this._cacheTimeout = 5 * 60 * 1000; // 5 minutes cache timeout
    }

    private _getCached<T>(key: string): T | null {
        const cached = this._cache.get(key);
        if (!cached) return null;

        const { data, timestamp } = cached;
        if (Date.now() - timestamp > this._cacheTimeout) {
            this._cache.delete(key);
            return null;
        }

        return data;
    }

    private _setCache<T>(key: string, data: T): void {
        this._cache.set(key, {
            data,
            timestamp: Date.now(),
        });
    }

    public getCluster(
        url: string,
        abort?: Promise<void>
    ): Promise<ClusterContract> {
        return fetchArrayBuffer(url, abort).then((buffer: ArrayBuffer) => {
            const reconstructions = <GraphClusterContract[]>decompress(buffer);

            if (reconstructions.length < 1) {
                throw new Error("Cluster reconstruction empty");
            }
            return this._convert.clusterReconstruction(reconstructions[0]);
        });
    }

    public getCoreImages(cellId: string): Promise<CoreImagesContract> {
        const cacheKey = `core_images_${cellId}`;
        const cached = this._getCached<CoreImagesContract>(cacheKey);
        if (cached) return Promise.resolve(cached);

        const fields = [...this._query.idFields, ...this._query.coreFields];
        const query = this._query.imagesS2(cellId, fields);
        const url = new URL(this._query.imagesPath, this._endpoint).href;

        return this._fetchGraphContract<GraphCoreImageEnt[]>(query, url).then(
            (r) => {
                const result: CoreImagesContract = {
                    cell_id: cellId,
                    images: [],
                };
                const items = r.data;
                for (const item of items) {
                    const coreImage = this._convert.coreImage(item);
                    result.images.push(coreImage);
                }
                this._setCache(cacheKey, result);
                return result;
            }
        );
    }

    public getImageBuffer(
        url: string,
        abort?: Promise<void>
    ): Promise<ArrayBuffer> {
        return fetchArrayBuffer(url, abort);
    }

    public getImages(imageIds: string[]): Promise<ImagesContract> {
        const cacheKey = `images_${imageIds.sort().join(",")}`;
        const cached = this._getCached<ImagesContract>(cacheKey);
        if (cached) return Promise.resolve(cached);

        const fields = [
            ...this._query.idFields,
            ...this._query.coreFields,
            ...this._query.spatialFields,
        ];
        const query = this._query.images(imageIds, fields);
        const url = new URL(this._query.imagesPath, this._endpoint).href;

        return this._fetchGraphContract<GraphImageEnt[]>(query, url).then(
            (r) => {
                const result: ImagesContract = [];
                const items = r.data;
                for (const item of items) {
                    const coreImage = this._convert.coreImage(item);
                    const spatialImage = this._convert.spatialImage(item);
                    this._setMeshParameters(spatialImage);
                    const image = Object.assign({}, spatialImage, coreImage);
                    const contract: EntContract<ImageEnt> = {
                        node: image,
                        node_id: item.id,
                    };
                    result.push(contract);
                }
                this._setCache(cacheKey, result);
                return result;
            }
        );
    }

    public getImageTiles(
        request: ImageTilesRequestContract
    ): Promise<ImageTilesContract> {
        const cacheKey = `image_tiles_${request.imageId}_${request.z}`;
        const cached = this._getCached<ImageTilesContract>(cacheKey);
        if (cached) return Promise.resolve(cached);

        const fields = [...this._query.imageTileFields];
        const query = this._query.imageTiles(request.z, fields);
        const url = new URL(
            this._query.imageTilesPath(request.imageId),
            this._endpoint
        ).href;

        return this._fetchGraphContract<ImageTileEnt[]>(query, url).then(
            (r) => {
                const result: ImageTilesContract = {
                    node: r.data,
                    node_id: request.imageId,
                };
                this._setCache(cacheKey, result);
                return result;
            }
        );
    }

    public getMesh(url: string, abort?: Promise<void>): Promise<MeshContract> {
        return fetchArrayBuffer(url, abort).then((buffer: ArrayBuffer) => {
            const mesh = readMeshPbf(buffer);
            return this._convert.mesh(mesh, this._meshParameters.get(url));
        });
    }

    public getSequence(sequenceId: string): Promise<SequenceContract> {
        const query = this._query.sequence(sequenceId);
        const url = new URL(this._query.sequencePath, this._endpoint).href;

        return this._fetchGraphContract<IDEnt[]>(query, url).then((r) => {
            const result: SequenceContract = {
                id: sequenceId,
                image_ids: r.data.map((item) => item.id),
            };
            return result;
        });
    }

    public getSpatialImages(
        imageIds: string[]
    ): Promise<SpatialImagesContract> {
        const cacheKey = `spatial_images_${imageIds.sort().join(",")}`;
        const cached = this._getCached<SpatialImagesContract>(cacheKey);
        if (cached) return Promise.resolve(cached);

        const fields = [
            ...this._query.idFields,
            ...this._query.coreFields,
            ...this._query.spatialFields,
        ];
        const query = this._query.images(imageIds, fields);
        const url = new URL(this._query.imagesPath, this._endpoint).href;

        return this._fetchGraphContract<GraphSpatialImageEnt[]>(
            query,
            url
        ).then((r) => {
            const result: SpatialImagesContract = [];
            const items = r.data;
            for (const item of items) {
                const spatialImage = this._convert.spatialImage(item);
                this._setMeshParameters(spatialImage);
                const contract: EntContract<SpatialImageEnt> = {
                    node: spatialImage,
                    node_id: item.id,
                };
                result.push(contract);
            }
            this._setCache(cacheKey, result);
            return result;
        });
    }

    public setAccessToken(accessToken: string): void {
        this._accessToken = accessToken;
    }

    private _createHeaders(): XMLHttpRequestHeader[] {
        const headers: XMLHttpRequestHeader[] = [
            { name: "Accept", value: "application/json" },
            {
                name: "Content-Type",
                value: "application/x-www-form-urlencoded",
            },
        ];

        if (this._accessToken) {
            headers.push({
                name: "Authorization",
                value: `OAuth ${this._accessToken}`,
            });
        }
        return headers;
    }

    private _fetchGraphContract<T>(
        body: string,
        url: string
    ): Promise<GraphContract<T>> {
        const method = this._method;
        const headers = this._createHeaders();
        const query = `${url}?${body}`;

        return xhrFetch<GraphContract<T>>(
            query,
            method,
            "json",
            headers,
            null,
            null
        ).catch((error: GraphError) => {
            const message = this._makeErrorMessage(error);
            throw new MapillaryError(message);
        });
    }

    private _makeErrorMessage(graphError: GraphError): string {
        const error = graphError.error;
        const message = error
            ? `${error.code} (${error.type}, ${error.fbtrace_id}): ${error.message}`
            : "Failed to fetch data";
        return message;
    }

    private _setMeshParameters(spatialImage: SpatialImageEnt): void {
        this._meshParameters.set(spatialImage.mesh.url, {
            perspective: spatialImage.camera_type === "perspective",
            scale: spatialImage.atomic_scale ?? 1,
        });
    }
}
