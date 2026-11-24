(function () {
  var data = window.GROWTH, select = document.getElementById("series");
  Object.keys(data.series).forEach(function (name) { var o = document.createElement("option"); o.value = o.textContent = name; select.appendChild(o); });
  var fromHash = function () { var m = /(?:^|[#&])s=([^&]+)/.exec(location.hash); return m && data.series[m[1]] ? m[1] : "control"; };
  function draw(name) {
    var rows = data.series[name], svg = document.getElementById("curve"), body = document.querySelector("#table tbody");
    var x = function (h) { return 40 + h * 22; }, y = function (v) { return 200 - v * 24; };
    svg.innerHTML = '<line x1="40" y1="200" x2="580" y2="200" class="axis"/><line x1="40" y1="200" x2="40" y2="10" class="axis"/>' +
      '<polyline class="line" points="' + rows.map(function (r) { return x(r[0]) + "," + y(r[1]); }).join(" ") + '"/>' +
      rows.map(function (r) { return '<circle class="dot" r="4" cx="' + x(r[0]) + '" cy="' + y(r[1]) + '"/>'; }).join("");
    body.innerHTML = rows.map(function (r) { return "<tr><td>" + r[0] + "</td><td>" + r[1].toFixed(1) + "</td></tr>"; }).join("");
    document.body.dataset.series = name;
    document.getElementById("stamp").textContent = "data version " + data.version;
  }
  select.value = fromHash();
  draw(select.value);
  select.addEventListener("change", function () { history.replaceState(null, "", "#s=" + select.value); draw(select.value); });
  addEventListener("hashchange", function () { select.value = fromHash(); draw(select.value); });
})();
