"""Tests for the raster edge sampler that replaced the polygon-overlay join.

These use a tiny synthetic grid and graph: no VoxCity import, no network.
"""
from __future__ import annotations

import unittest

import networkx as nx
import numpy as np

from pipeline import precompute


def make_grid_graph():
    """A 100x100 m tile at the equator with a 10x10 exposure grid.

    Grid values are row-major ``arange(100)`` with row 0 on the southern edge,
    matching VoxCity's SOUTH_UP raster convention.
    """
    rect = precompute.rectangle_from_center(0.0, 0.0, 100, 100)
    grid = np.arange(100, dtype=float).reshape(10, 10)
    lons = [p[0] for p in rect]
    lats = [p[1] for p in rect]
    west, east = min(lons), max(lons)
    south, north = min(lats), max(lats)

    def at(x_m, y_m):
        """Position in meters from the tile's SW corner -> (lon, lat)."""
        return (
            west + (east - west) * (x_m / 100),
            south + (north - south) * (y_m / 100),
        )

    return rect, grid, at


class EdgeRasterSamplerTests(unittest.TestCase):
    def test_straight_edge_averages_the_cells_it_crosses(self):
        rect, grid, at = make_grid_graph()
        G = nx.MultiGraph()
        # Horizontal edge through row 5 (55 m north of the SW corner),
        # crossing columns 1..8: cell values 51..58, mean 54.5.
        (x0, y0), (x1, y1) = at(10.1, 55), at(89.9, 55)
        G.add_node(1, x=x0, y=y0)
        G.add_node(2, x=x1, y=y1)
        G.add_edge(1, 2, key=0)

        samplers = precompute.edge_raster_samplers(G, rect, grid.shape)
        values = precompute.sample_edge_exposures(grid, samplers)

        self.assertAlmostEqual(values[(1, 2, 0)], 54.5, delta=0.2)

    def test_nan_cells_are_excluded_from_the_mean(self):
        rect, grid, at = make_grid_graph()
        grid[5, 4] = np.nan  # value 54 drops out; mean of the rest is ~54.57
        G = nx.MultiGraph()
        (x0, y0), (x1, y1) = at(10.1, 55), at(89.9, 55)
        G.add_node(1, x=x0, y=y0)
        G.add_node(2, x=x1, y=y1)
        G.add_edge(1, 2, key=0)

        samplers = precompute.edge_raster_samplers(G, rect, grid.shape)
        values = precompute.sample_edge_exposures(grid, samplers)

        expected = (51 + 52 + 53 + 55 + 56 + 57 + 58) / 7
        self.assertAlmostEqual(values[(1, 2, 0)], expected, delta=0.2)

    def test_edge_outside_the_grid_stays_unmapped(self):
        rect, grid, at = make_grid_graph()
        G = nx.MultiGraph()
        (x0, y0), (x1, y1) = at(10, 250), at(90, 250)  # 150 m north of the tile
        G.add_node(1, x=x0, y=y0)
        G.add_node(2, x=x1, y=y1)
        G.add_edge(1, 2, key=0)

        samplers = precompute.edge_raster_samplers(G, rect, grid.shape)
        values = precompute.sample_edge_exposures(grid, samplers)

        self.assertEqual(samplers[(1, 2, 0)].size, 0)
        self.assertNotIn((1, 2, 0), values)

    def test_explicit_geometry_matches_straight_line_between_nodes(self):
        from shapely.geometry import LineString

        rect, grid, at = make_grid_graph()
        (x0, y0), (x1, y1) = at(10.1, 55), at(89.9, 55)

        straight = nx.MultiGraph()
        straight.add_node(1, x=x0, y=y0)
        straight.add_node(2, x=x1, y=y1)
        straight.add_edge(1, 2, key=0)

        explicit = nx.MultiGraph()
        explicit.add_node(1, x=x0, y=y0)
        explicit.add_node(2, x=x1, y=y1)
        explicit.add_edge(1, 2, key=0, geometry=LineString([(x0, y0), (x1, y1)]))

        a = precompute.sample_edge_exposures(
            grid, precompute.edge_raster_samplers(straight, rect, grid.shape)
        )
        b = precompute.sample_edge_exposures(
            grid, precompute.edge_raster_samplers(explicit, rect, grid.shape)
        )
        self.assertAlmostEqual(a[(1, 2, 0)], b[(1, 2, 0)], places=9)


if __name__ == "__main__":
    unittest.main()
