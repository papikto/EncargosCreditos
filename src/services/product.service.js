/**
 * ProductService - DeepSeek Harness Provider
 * Servicio de Inventario, Catálogo de Productos y Cotización Rápida de Precios.
 *
 * Características:
 * 1. Almacenamiento Offline-First en IndexedDB (tabla 'products').
 * 2. Soporte de imagen por link/URL externa para mantener la base de datos ultraligera.
 * 3. Gestión de triple precio: Compra (Costo), Venta (Detal) y Al Mayor (Mayoreo).
 * 4. Control de existencias (Stock) y niveles de alerta de Stock Mínimo.
 * 5. Ubicación física del producto (Almacén, estante, pasillo, vitrina).
 * 6. Sincronización automática con Supabase en tiempo real y Guardián Anti-Colisión.
 * 7. Cotizador instantáneo para responder precios y generar mensajes de WhatsApp en 1 clic.
 */

import { storageService } from './storage.service.js';
import { supabaseService } from './supabase.service.js';

const PRODUCT_SEED_FLAG = 'products_seed_v1_completed';
const DELETED_PRODUCTS_KEY = 'deleted_products_v1';

class ProductService {
  generateId() {
    return 'PRD-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).substring(2, 6).toUpperCase();
  }

  /**
   * Obtiene todos los productos del inventario
   * @param {boolean} includeInactive - Si incluye productos marcados como inactivos
   */
  async getAllProducts(includeInactive = false) {
    await this.seedDefaultProductsIfEmpty();
    const products = await storageService.getAll('products');
    
    let deletedIds = [];
    try {
      deletedIds = JSON.parse(localStorage.getItem(DELETED_PRODUCTS_KEY) || '[]');
    } catch (e) {}

    const nonDeleted = Array.isArray(deletedIds) && deletedIds.length > 0
      ? products.filter(p => !deletedIds.includes(p.id))
      : products;

    const filtered = includeInactive ? nonDeleted : nonDeleted.filter(p => p.activo !== false);
    
    // Ordenar alfabéticamente por nombre
    return filtered.sort((a, b) => (a.nombre || '').localeCompare(b.nombre || ''));
  }

  async getProductById(id) {
    if (!id) return null;
    return storageService.getById('products', id);
  }

  /**
   * Guarda o actualiza un producto en el inventario
   * @param {Object} productData
   */
  async saveProduct(productData) {
    const now = new Date().toISOString();

    const precioCompra = Math.max(0, Number(productData.precioCompra) || 0);
    const precioVenta = Math.max(0, Number(productData.precioVenta) || 0);
    const precioMayor = Math.max(0, Number(productData.precioMayor) || 0);
    const stock = Math.max(0, parseInt(productData.stock, 10) || 0);
    const stockMinimo = Math.max(0, parseInt(productData.stockMinimo, 10) || 1);

    const product = {
      id: productData.id || this.generateId(),
      nombre: (productData.nombre || '').trim() || 'Producto sin nombre',
      descripcion: (productData.descripcion || '').trim(),
      sku: (productData.sku || '').trim().toUpperCase(),
      categoria: (productData.categoria || '').trim() || 'General',
      imagenUrl: (productData.imagenUrl || '').trim(),
      precioCompra,
      precioVenta,
      precioMayor,
      ubicacion: (productData.ubicacion || '').trim(),
      stock,
      stockMinimo,
      notas: (productData.notas || '').trim(),
      activo: productData.activo !== undefined ? Boolean(productData.activo) : true,
      createdAt: productData.createdAt || now,
      updatedAt: now
    };

    // Guardar en IndexedDB local
    localStorage.setItem(PRODUCT_SEED_FLAG, 'true');
    // Si estaba marcado en lista de eliminados, removerlo
    if (productData.id) {
      try {
        let deleted = JSON.parse(localStorage.getItem(DELETED_PRODUCTS_KEY) || '[]');
        if (deleted.includes(productData.id)) {
          deleted = deleted.filter(x => x !== productData.id);
          localStorage.setItem(DELETED_PRODUCTS_KEY, JSON.stringify(deleted));
        }
      } catch (e) {}
    }

    await storageService.put('products', product);

    // Enviar a Supabase si la nube está configurada (no bloqueante)
    supabaseService.pushRecord('products', product).catch((err) => {
      console.warn('[ProductService] Envío a Supabase encolado u omitido:', err.message);
    });

    return product;
  }

  /**
   * Elimina un producto del inventario
   * @param {string} id
   */
  async deleteProduct(id) {
    if (!id) return false;
    localStorage.setItem(PRODUCT_SEED_FLAG, 'true');

    try {
      let deleted = JSON.parse(localStorage.getItem(DELETED_PRODUCTS_KEY) || '[]');
      if (!deleted.includes(id)) {
        deleted.push(id);
        localStorage.setItem(DELETED_PRODUCTS_KEY, JSON.stringify(deleted));
      }
    } catch (e) {}

    supabaseService.pushDelete('products', id).catch(() => {});
    return storageService.delete('products', id);
  }

  /**
   * Ajusta el stock de un producto (añade o descuenta)
   * @param {string} id - ID del producto
   * @param {number} deltaOrQty - Cantidad a sumar/restar o valor absoluto
   * @param {string} mode - 'delta' (suma/resta) o 'absolute' (fija el valor)
   */
  async adjustStock(id, deltaOrQty, mode = 'delta') {
    const product = await this.getProductById(id);
    if (!product) throw new Error('Producto no encontrado');

    let newStock = product.stock;
    if (mode === 'absolute') {
      newStock = Math.max(0, parseInt(deltaOrQty, 10) || 0);
    } else {
      newStock = Math.max(0, (product.stock || 0) + (parseInt(deltaOrQty, 10) || 0));
    }

    product.stock = newStock;
    product.updatedAt = new Date().toISOString();

    localStorage.setItem(PRODUCT_SEED_FLAG, 'true');
    // Si estaba marcado en lista de eliminados, removerlo
    if (productData.id) {
      try {
        let deleted = JSON.parse(localStorage.getItem(DELETED_PRODUCTS_KEY) || '[]');
        if (deleted.includes(productData.id)) {
          deleted = deleted.filter(x => x !== productData.id);
          localStorage.setItem(DELETED_PRODUCTS_KEY, JSON.stringify(deleted));
        }
      } catch (e) {}
    }

    await storageService.put('products', product);
    supabaseService.pushRecord('products', product).catch(() => {});

    return product;
  }

  /**
   * Búsqueda y filtrado de productos
   */
  async searchProducts(query = '', category = 'all', stockStatus = 'all') {
    const all = await this.getAllProducts();
    const q = (query || '').toLowerCase().trim();

    return all.filter(p => {
      // 1. Filtro de texto (nombre, sku, descripcion, ubicacion, categoria)
      if (q) {
        const match = 
          (p.nombre && p.nombre.toLowerCase().includes(q)) ||
          (p.sku && p.sku.toLowerCase().includes(q)) ||
          (p.descripcion && p.descripcion.toLowerCase().includes(q)) ||
          (p.ubicacion && p.ubicacion.toLowerCase().includes(q)) ||
          (p.categoria && p.categoria.toLowerCase().includes(q));
        if (!match) return false;
      }

      // 2. Filtro de categoría
      if (category && category !== 'all') {
        if ((p.categoria || '').toLowerCase() !== category.toLowerCase()) {
          return false;
        }
      }

      // 3. Filtro de stock
      if (stockStatus === 'in_stock') {
        if (p.stock <= (p.stockMinimo || 1)) return false;
      } else if (stockStatus === 'low_stock') {
        if (p.stock <= 0 || p.stock > (p.stockMinimo || 1)) return false;
      } else if (stockStatus === 'out_of_stock') {
        if (p.stock > 0) return false;
      }

      return true;
    });
  }

  /**
   * Lista única de categorías existentes
   */
  async getCategories() {
    const products = await this.getAllProducts();
    const catSet = new Set();
    products.forEach(p => {
      if (p.categoria && p.categoria.trim()) {
        catSet.add(p.categoria.trim());
      }
    });
    return Array.from(catSet).sort();
  }

  /**
   * Calcula métricas globales del inventario para el Dashboard
   */
  async getInventoryMetrics() {
    const products = await this.getAllProducts();

    let totalProducts = products.length;
    let totalStock = 0;
    let totalCostValue = 0;
    let totalSaleValue = 0;
    let lowStockCount = 0;
    let outOfStockCount = 0;

    products.forEach(p => {
      const stock = p.stock || 0;
      const min = p.stockMinimo || 1;
      const cost = p.precioCompra || 0;
      const price = p.precioVenta || 0;

      totalStock += stock;
      totalCostValue += (stock * cost);
      totalSaleValue += (stock * price);

      if (stock <= 0) {
        outOfStockCount++;
      } else if (stock <= min) {
        lowStockCount++;
      }
    });

    const projectedProfit = Math.max(0, totalSaleValue - totalCostValue);
    const profitMarginPercent = totalSaleValue > 0 ? ((projectedProfit / totalSaleValue) * 100) : 0;

    return {
      totalProducts,
      totalStock,
      totalCostValue,
      totalSaleValue,
      projectedProfit,
      profitMarginPercent,
      lowStockCount,
      outOfStockCount
    };
  }

  /**
   * Genera texto preformateado para cotización rápida por WhatsApp
   */
  formatWhatsAppQuote(product, currency = '$', companyName = 'Encargos & Apartados') {
    const p = product;
    const stockStatus = p.stock > 0 
      ? `✅ Disponible en inventario (${p.stock} unidades)` 
      : `⏳ Por encargo / agotado en tienda`;

    return `*${companyName}* 📦
Hola! Te comparto la información y precio actualizado del producto:

🛍️ *${p.nombre}*
${p.descripcion ? `📝 ${p.descripcion}\n` : ''}🏷️ *Precio al Detal:* ${currency} ${(p.precioVenta || 0).toFixed(2)}
📦 *Precio al Mayor:* ${currency} ${(p.precioMayor || 0).toFixed(2)}
${stockStatus}
${p.ubicacion ? `📍 Ubicación: ${p.ubicacion}\n` : ''}
¡Quedamos a tu orden para apartarlo o procesar tu encargo de inmediato! 🚀`;
  }

  /**
   * Si la tienda de productos está totalmente vacía, siembra datos iniciales
   * con imágenes ligeras vía link de Unsplash para que el usuario explore el catálogo.
   */
  async seedDefaultProductsIfEmpty() {
    // Si ya se procesó la siembra inicial alguna vez en este navegador, NUNCA volver a sembrar
    if (localStorage.getItem(PRODUCT_SEED_FLAG) === 'true') {
      return;
    }

    const existing = await storageService.getAll('products');
    if (existing && existing.length > 0) {
      localStorage.setItem(PRODUCT_SEED_FLAG, 'true');
      return;
    }

    // Marcar como sembrado de inmediato para que si el usuario los elimina no vuelvan a aparecer
    localStorage.setItem(PRODUCT_SEED_FLAG, 'true');

    const defaultProducts = [
      {
        id: 'PRD-DEMO-001',
        nombre: 'Zapatillas Deportivas Running Air Max Pro',
        descripcion: 'Calzado deportivo con amortiguación reactiva, tejido transpirable, suela antideslizante.',
        sku: 'RUN-AIR-01',
        categoria: 'Calzado',
        imagenUrl: 'https://images.unsplash.com/photo-1542291026-7eec264c27ff?w=600&auto=format&fit=crop&q=80',
        precioCompra: 32.00,
        precioVenta: 65.00,
        precioMayor: 50.00,
        ubicacion: 'Almacén Central - Estante A-2',
        stock: 14,
        stockMinimo: 3,
        notas: 'Tallas surtidas del 38 al 44. Proveedor Importaciones Andes.',
        activo: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      {
        id: 'PRD-DEMO-002',
        nombre: 'Auriculares Inalámbricos Bluetooth Pro TWS',
        descripcion: 'Cancelación de ruido activa, estuche con carga inalámbrica, batería de 28 horas.',
        sku: 'AUD-TWS-02',
        categoria: 'Electrónica',
        imagenUrl: 'https://images.unsplash.com/photo-1590658268037-6bf12165a8df?w=600&auto=format&fit=crop&q=80',
        precioCompra: 14.50,
        precioVenta: 29.99,
        precioMayor: 22.00,
        ubicacion: 'Vitrina 1 - Mostrador Principal',
        stock: 8,
        stockMinimo: 2,
        notas: 'Incluye cable USB-C y almohadillas de recambio.',
        activo: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      {
        id: 'PRD-DEMO-003',
        nombre: 'Reloj Inteligente Smartwatch Deportivo Fit Pro',
        descripcion: 'Pantalla AMOLED 1.4", monitor de ritmo cardíaco, oxígeno en sangre, resistencia al agua IP68.',
        sku: 'REL-SMT-03',
        categoria: 'Tecnología',
        imagenUrl: 'https://images.unsplash.com/photo-1508685096489-7aacd43bd3b1?w=600&auto=format&fit=crop&q=80',
        precioCompra: 22.00,
        precioVenta: 48.00,
        precioMayor: 38.00,
        ubicacion: 'Almacén Central - Gaveta B-4',
        stock: 5,
        stockMinimo: 2,
        notas: 'Compatible con Android e iOS.',
        activo: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      {
        id: 'PRD-DEMO-004',
        nombre: 'Mochila Urbana Impermeable con Puerto USB',
        descripcion: 'Compartimento acolchado para laptop de hasta 15.6", tela oxford repelente al agua, antirrobo.',
        sku: 'MOC-URB-04',
        categoria: 'Accesorios',
        imagenUrl: 'https://images.unsplash.com/photo-1553062407-98eeb64c6a62?w=600&auto=format&fit=crop&q=80',
        precioCompra: 12.00,
        precioVenta: 26.00,
        precioMayor: 19.50,
        ubicacion: 'Pasillo 3 - Estante Superior',
        stock: 2,
        stockMinimo: 3,
        notas: 'Colores negro y gris carbón.',
        activo: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    ];

    for (const p of defaultProducts) {
      await storageService.put('products', p);
    }
  }
}

export const productService = new ProductService();
