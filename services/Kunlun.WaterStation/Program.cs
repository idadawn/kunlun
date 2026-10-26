using Kunlun.WaterStation;

var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();

app.MapGet("/healthz", () => Results.Ok(new
{
    plugin = "kunlun.waterstation",
    brand = "绿麒麟水站｜小分子团弱碱活性水",
    slogan = "鲜活每一滴，好水到你家",
    status = "healthy"
}));

app.Run();
