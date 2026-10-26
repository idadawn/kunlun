using Npgsql;
using NpgsqlTypes;

namespace Kunlun.WaterStation.Operations;

/// <summary>
/// 列表分页。未传 page / pageSize 时保持旧接口：返回数组且只取最新 legacyLimit 条；
/// 传入任一参数时返回 { rows, total, page, pageSize }（与袋桶台账分页接口一致），pageSize 限定在 1..100。
/// </summary>
public readonly record struct Paging(bool Paged, int Page, int PageSize)
{
    public const int DefaultPageSize = 20;
    public const int MaxPageSize = 100;

    public static Paging From(int? page, int? pageSize, int legacyLimit) =>
        page is null && pageSize is null
            ? new(false, 1, legacyLimit)
            : new(true, Math.Max(1, page ?? 1), Math.Clamp(pageSize ?? DefaultPageSize, 1, MaxPageSize));

    public long Offset => (Page - 1L) * PageSize;

    /// <summary>
    /// 执行 SELECT {columns} FROM {source} ORDER BY {orderBy} 的一页；source 含 JOIN 与 WHERE。
    /// bind 会分别作用于分页查询和计数查询，因此每次都要新建参数。
    /// </summary>
    public async Task<IResult> Query<T>(NpgsqlConnection conn, string columns, string source, string orderBy,
        Action<NpgsqlParameterCollection> bind, Func<NpgsqlDataReader, T> read, CancellationToken ct)
    {
        var items = new List<T>();
        await using (var cmd = new NpgsqlCommand($"SELECT {columns} FROM {source} ORDER BY {orderBy} LIMIT @page_limit OFFSET @page_offset", conn))
        {
            bind(cmd.Parameters);
            cmd.Parameters.AddWithValue("page_limit", PageSize);
            cmd.Parameters.AddWithValue("page_offset", Offset);
            await using var r = await cmd.ExecuteReaderAsync(ct);
            while (await r.ReadAsync(ct)) items.Add(read(r));
        }
        if (!Paged) return Results.Ok(items);

        // 未取满一页时总数可直接推出；越界的空页仍需计数。
        long total;
        if (items.Count < PageSize && (items.Count > 0 || Page == 1)) total = Offset + items.Count;
        else
        {
            await using var count = new NpgsqlCommand($"SELECT count(*) FROM {source}", conn);
            bind(count.Parameters);
            total = (long)(await count.ExecuteScalarAsync(ct))!;
        }
        return Results.Ok(new { rows = items, total, page = Page, pageSize = PageSize });
    }

    /// <summary>模糊搜索参数：空白视为不过滤，% _ \ 按字面匹配。</summary>
    public static NpgsqlParameter Like(string name, string? q) => new(name, NpgsqlDbType.Varchar)
    {
        Value = string.IsNullOrWhiteSpace(q) ? DBNull.Value
            : $"%{q.Trim().Replace(@"\", @"\\").Replace("%", @"\%").Replace("_", @"\_")}%"
    };

    public static NpgsqlParameter Text(string name, string? value) => new(name, NpgsqlDbType.Varchar)
    {
        Value = string.IsNullOrWhiteSpace(value) ? DBNull.Value : value.Trim()
    };

    public static NpgsqlParameter Time(string name, DateTimeOffset? value) => new(name, NpgsqlDbType.TimestampTz)
    {
        Value = value is { } v ? v.UtcDateTime : DBNull.Value
    };
}
