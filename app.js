/**
 * Jihu Slicer - Application Controller & State Management
 * Built for Creality CR-10 V3 Concrete Printer (Auger Screw + 500ml External Piston)
 */

(function () {
  const STORAGE_KEY_RECIPES = 'cim_slicer_mix_recipes_v2';
  const STORAGE_KEY_ACTIVE_RECIPE = 'cim_slicer_active_recipe_id_v2';
  const STORAGE_KEY_PRESETS = 'cim_slicer_setting_presets_v1';
  const STORAGE_KEY_ACTIVE_PRESET = 'cim_slicer_active_preset_id_v1';
  const STORAGE_KEY_CURRENT_SETTINGS = 'cim_slicer_current_settings_v1';
  const STORAGE_KEY_IS_PRESET_MODIFIED = 'cim_slicer_is_preset_modified_v1';

  // Desktop native persistence (%APPDATA%/CIM Slicer) & localStorage unified adapter
  const appStorage = {
    _cache: null,
    _init() {
      if (this._cache) return;
      if (window.cimDesktopBridge && typeof window.cimDesktopBridge.loadAllSync === 'function') {
        this._cache = window.cimDesktopBridge.loadAllSync() || {};
      } else {
        this._cache = {};
      }
    },
    getItem(key) {
      this._init();
      if (this._cache && this._cache[key] !== undefined && this._cache[key] !== null) {
        return this._cache[key];
      }
      try {
        return localStorage.getItem(key);
      } catch (e) {
        return null;
      }
    },
    setItem(key, value) {
      this._init();
      const strVal = String(value);
      this._cache[key] = strVal;
      try {
        localStorage.setItem(key, strVal);
      } catch (e) {}
      if (window.cimDesktopBridge && typeof window.cimDesktopBridge.setItem === 'function') {
        window.cimDesktopBridge.setItem(key, strVal);
      }
    },
    removeItem(key) {
      this._init();
      delete this._cache[key];
      try {
        localStorage.removeItem(key);
      } catch (e) {}
      if (window.cimDesktopBridge && typeof window.cimDesktopBridge.saveAll === 'function') {
        window.cimDesktopBridge.saveAll(this._cache);
      }
    }
  };

  // Default Setting Presets (OrcaSlicer Process Style for Concrete 3D Printing)
  const DEFAULT_PRESETS = [
    {
      id: 'system_standard_5mm',
      name: '0.25cm Standard (5mm Line Width · 2.5mm Layer)',
      isDefault: true,
      settings: {
        bedX: 300,
        bedY: 300,
        bedZ: 380,
        nozzleDiameter: 5,
        ptfeInnerDia: 6.0,
        ptfeLengthMm: 800,
        includeTubeInMixCalc: false,
        materialType: 'concrete',
        printMode: 'standard',
        layerHeight: 2.5,
        firstLayerHeight: 2.5,
        lineWidth: 5.0,
        outerWallWidth: 5.0,
        innerWallWidth: 5.0,
        infillLineWidth: 5.0,
        crossSectionModel: 'capsule',
        wallCount: 2,
        topSurfacePattern: 'monotonic',
        topLayers: 2,
        bottomSurfacePattern: 'monotonic',
        bottomLayers: 2,
        internalSolidInfillPattern: 'match_surface',
        infillDensity: 15,
        infillPattern: 'grid',
        seamPosition: 'aligned',
        singleWallIncludeInnerHoles: true,
        vaseBottomLayer: true,
        printSpeed: 25,
        firstLayerSpeed: 25,
        outerWallSpeed: 25,
        innerWallSpeed: 25,
        infillSpeed: 25,
        travelSpeed: 80,
        printAcceleration: 300,
        flowRatio: 1.0,
        eAxisMode: 'filament',
        equivFilamentDia: 1.75,
        augerMmPerMl: 10.0,
        retractEnabled: true,
        retractDistance: 1.5,
        retractSpeed: 15,
        zHop: 1.5,
        // Support & Manual Layer Pause
        enableSupport: false,
        supportOverhangAngle: 30,
        supportWallThickness: 3.5,
        supportClearanceXY: 0.8,
        supportClearanceZ: 0.4,
        supportAutoPause: true,
        supportPauseLayers: '',
        pistonAutoPause: true,
        pistonCapacityMl: 500,
        pistonPauseThreshold: 90,
        supportParkX: 10,
        supportParkY: 10,
        supportParkLiftZ: 10.0,
        supportRetractDist: 2.5,
        supportPauseCommand: 'M0',
        startGcode: [
          'M104 S0 ; Disable hotend heater (Concrete Mode)',
          'M140 S0 ; Disable bed heater',
          'M302 P1 ; Allow cold extrusion for Auger Screw',
          'M204 P300 T500 ; Set gentle acceleration for heavy auger head',
          'G28 ; Home all axes',
          'G1 Z10.0 F600 ; Lift nozzle safely before moving to start'
        ].join('\n'),
        endGcode: [
          'G91 ; Relative positioning',
          'G1 E-2.5 F900 ; Decompress auger screw to stop cement ooze',
          'G1 Z15.0 F600 ; Lift Z above concrete print',
          'G90 ; Absolute positioning',
          'G1 X0 Y280 F3000 ; Present print forward on bed',
          'M84 ; Disable steppers'
        ].join('\n')
      }
    },
    {
      id: 'system_direct_auger_40mms',
      name: '0.25cm Fast Direct Auger (40mm/s · 10mm/ml)',
      isDefault: true,
      settings: {
        bedX: 300,
        bedY: 300,
        bedZ: 380,
        nozzleDiameter: 5,
        ptfeInnerDia: 6.0,
        ptfeLengthMm: 800,
        includeTubeInMixCalc: false,
        materialType: 'concrete',
        printMode: 'standard',
        layerHeight: 2.5,
        firstLayerHeight: 2.5,
        lineWidth: 5.0,
        outerWallWidth: 5.0,
        innerWallWidth: 5.0,
        infillLineWidth: 5.0,
        crossSectionModel: 'capsule',
        wallCount: 2,
        topSurfacePattern: 'monotonic',
        topLayers: 2,
        bottomSurfacePattern: 'monotonic',
        bottomLayers: 2,
        internalSolidInfillPattern: 'match_surface',
        infillDensity: 15,
        infillPattern: 'grid',
        seamPosition: 'aligned',
        singleWallIncludeInnerHoles: true,
        vaseBottomLayer: true,
        printSpeed: 40,
        firstLayerSpeed: 40,
        outerWallSpeed: 40,
        innerWallSpeed: 40,
        infillSpeed: 40,
        travelSpeed: 100,
        printAcceleration: 400,
        flowRatio: 1.0,
        eAxisMode: 'mm_per_ml',
        equivFilamentDia: 1.75,
        augerMmPerMl: 10.0,
        retractEnabled: true,
        retractDistance: 1.0,
        retractSpeed: 20,
        zHop: 1.5,
        // Support & Manual Layer Pause
        enableSupport: false,
        supportOverhangAngle: 30,
        supportWallThickness: 3.5,
        supportClearanceXY: 0.8,
        supportClearanceZ: 0.4,
        supportAutoPause: true,
        supportPauseLayers: '',
        pistonAutoPause: true,
        pistonCapacityMl: 500,
        pistonPauseThreshold: 90,
        supportParkX: 10,
        supportParkY: 10,
        supportParkLiftZ: 10.0,
        supportRetractDist: 2.5,
        supportPauseCommand: 'M0',
        startGcode: [
          'M104 S0 ; Disable hotend heater (Concrete Mode)',
          'M140 S0 ; Disable bed heater',
          'M302 P1 ; Allow cold extrusion for Auger Screw',
          'M203 E120 ; Unlock extruder max feedrate for direct auger metering',
          'M204 P400 T600 ; Smooth acceleration for high-speed print',
          'G28 ; Home all axes',
          'G1 Z10.0 F600 ; Lift nozzle safely before moving to start'
        ].join('\n'),
        endGcode: [
          'G91 ; Relative positioning',
          'G1 E-2.5 F900 ; Decompress auger screw to stop cement ooze',
          'G1 Z15.0 F600 ; Lift Z above concrete print',
          'G90 ; Absolute positioning',
          'G1 X0 Y280 F3000 ; Present print forward on bed',
          'M84 ; Disable steppers'
        ].join('\n')
      }
    },
    {
      id: 'system_spiral_vase',
      name: '0.22cm Spiralize Vase (Single Continuous Wall)',
      isDefault: true,
      settings: {
        bedX: 300,
        bedY: 300,
        bedZ: 380,
        nozzleDiameter: 5,
        ptfeInnerDia: 6.0,
        ptfeLengthMm: 800,
        includeTubeInMixCalc: false,
        materialType: 'concrete',
        printMode: 'spiral_vase',
        layerHeight: 2.2,
        firstLayerHeight: 2.5,
        lineWidth: 5.5,
        outerWallWidth: 5.5,
        innerWallWidth: 5.0,
        infillLineWidth: 5.0,
        crossSectionModel: 'capsule',
        wallCount: 1,
        topSurfacePattern: 'concentric',
        topLayers: 0,
        bottomSurfacePattern: 'concentric',
        bottomLayers: 2,
        internalSolidInfillPattern: 'match_surface',
        infillDensity: 0,
        infillPattern: 'grid',
        seamPosition: 'aligned',
        singleWallIncludeInnerHoles: true,
        vaseBottomLayer: true,
        printSpeed: 35,
        firstLayerSpeed: 35,
        outerWallSpeed: 35,
        innerWallSpeed: 35,
        infillSpeed: 35,
        travelSpeed: 80,
        printAcceleration: 350,
        flowRatio: 1.05,
        eAxisMode: 'mm_per_ml',
        equivFilamentDia: 1.75,
        augerMmPerMl: 10.0,
        retractEnabled: false,
        retractDistance: 0,
        retractSpeed: 15,
        zHop: 0,
        // Support & Manual Layer Pause
        enableSupport: false,
        supportOverhangAngle: 30,
        supportWallThickness: 3.5,
        supportClearanceXY: 0.8,
        supportClearanceZ: 0.4,
        supportAutoPause: true,
        supportPauseLayers: '',
        pistonAutoPause: true,
        pistonCapacityMl: 500,
        pistonPauseThreshold: 90,
        supportParkX: 10,
        supportParkY: 10,
        supportParkLiftZ: 10.0,
        supportRetractDist: 2.5,
        supportPauseCommand: 'M0',
        startGcode: [
          'M104 S0 ; Disable hotend heater (Concrete Mode)',
          'M140 S0 ; Disable bed heater',
          'M302 P1 ; Allow cold extrusion for Auger Screw',
          'M203 E120 ; Unlock extruder max feedrate for direct auger metering',
          'M204 P350 T500 ; Moderate acceleration for continuous spiral',
          'G28 ; Home all axes',
          'G1 Z10.0 F600 ; Lift nozzle safely before moving to start'
        ].join('\n'),
        endGcode: [
          'G91 ; Relative positioning',
          'G1 E-2.5 F900 ; Decompress auger screw to stop cement ooze',
          'G1 Z15.0 F600 ; Lift Z above concrete print',
          'G90 ; Absolute positioning',
          'G1 X0 Y280 F3000 ; Present print forward on bed',
          'M84 ; Disable steppers'
        ].join('\n')
      }
    },
    {
      id: 'system_fine_4mm',
      name: '0.18cm Fine Detail (4mm Line Width · High Resolution)',
      isDefault: true,
      settings: {
        bedX: 300,
        bedY: 300,
        bedZ: 380,
        nozzleDiameter: 4,
        ptfeInnerDia: 6.0,
        ptfeLengthMm: 800,
        includeTubeInMixCalc: false,
        materialType: 'concrete',
        printMode: 'standard',
        layerHeight: 1.8,
        firstLayerHeight: 2.0,
        lineWidth: 4.0,
        outerWallWidth: 4.0,
        innerWallWidth: 4.0,
        infillLineWidth: 4.0,
        crossSectionModel: 'capsule',
        wallCount: 2,
        topSurfacePattern: 'monotonic',
        topLayers: 3,
        bottomSurfacePattern: 'monotonic',
        bottomLayers: 3,
        internalSolidInfillPattern: 'match_surface',
        infillDensity: 20,
        infillPattern: 'grid',
        seamPosition: 'aligned',
        singleWallIncludeInnerHoles: true,
        vaseBottomLayer: true,
        printSpeed: 20,
        firstLayerSpeed: 20,
        outerWallSpeed: 20,
        innerWallSpeed: 20,
        infillSpeed: 20,
        travelSpeed: 70,
        printAcceleration: 250,
        flowRatio: 1.0,
        eAxisMode: 'mm_per_ml',
        equivFilamentDia: 1.75,
        augerMmPerMl: 10.0,
        retractEnabled: true,
        retractDistance: 1.5,
        retractSpeed: 15,
        zHop: 1.5,
        // Support & Manual Layer Pause
        enableSupport: false,
        supportOverhangAngle: 30,
        supportWallThickness: 3.5,
        supportClearanceXY: 0.8,
        supportClearanceZ: 0.4,
        supportAutoPause: true,
        supportPauseLayers: '',
        pistonAutoPause: true,
        pistonCapacityMl: 500,
        pistonPauseThreshold: 90,
        supportParkX: 10,
        supportParkY: 10,
        supportParkLiftZ: 10.0,
        supportRetractDist: 2.5,
        supportPauseCommand: 'M0',
        startGcode: [
          'M104 S0 ; Disable hotend heater (Concrete Mode)',
          'M140 S0 ; Disable bed heater',
          'M302 P1 ; Allow cold extrusion for Auger Screw',
          'M203 E120 ; Unlock extruder max feedrate for direct auger metering',
          'M204 P250 T400 ; Gentle acceleration for fine bead accuracy',
          'G28 ; Home all axes',
          'G1 Z10.0 F600 ; Lift nozzle safely before moving to start'
        ].join('\n'),
        endGcode: [
          'G91 ; Relative positioning',
          'G1 E-2.5 F900 ; Decompress auger screw to stop cement ooze',
          'G1 Z15.0 F600 ; Lift Z above concrete print',
          'G90 ; Absolute positioning',
          'G1 X0 Y280 F3000 ; Present print forward on bed',
          'M84 ; Disable steppers'
        ].join('\n')
      }
    },
    {
      id: 'system_heavy_10mm',
      name: '0.45cm Heavy Bead (10mm Line Width · Fast Structural)',
      isDefault: true,
      settings: {
        bedX: 300,
        bedY: 300,
        bedZ: 380,
        nozzleDiameter: 10,
        ptfeInnerDia: 6.0,
        ptfeLengthMm: 800,
        includeTubeInMixCalc: false,
        materialType: 'concrete',
        printMode: 'single_wall',
        layerHeight: 4.5,
        firstLayerHeight: 4.5,
        lineWidth: 10.0,
        outerWallWidth: 10.0,
        innerWallWidth: 10.0,
        infillLineWidth: 10.0,
        crossSectionModel: 'capsule',
        wallCount: 1,
        topSurfacePattern: 'concentric',
        topLayers: 0,
        bottomSurfacePattern: 'concentric',
        bottomLayers: 2,
        internalSolidInfillPattern: 'match_surface',
        infillDensity: 0,
        infillPattern: 'grid',
        seamPosition: 'aligned',
        singleWallIncludeInnerHoles: true,
        vaseBottomLayer: true,
        printSpeed: 25,
        firstLayerSpeed: 25,
        outerWallSpeed: 25,
        innerWallSpeed: 25,
        infillSpeed: 25,
        travelSpeed: 80,
        printAcceleration: 250,
        flowRatio: 1.0,
        eAxisMode: 'mm_per_ml',
        equivFilamentDia: 1.75,
        augerMmPerMl: 8.0,
        retractEnabled: true,
        retractDistance: 2.0,
        retractSpeed: 15,
        zHop: 2.0,
        // Support & Manual Layer Pause
        enableSupport: false,
        supportOverhangAngle: 30,
        supportWallThickness: 3.5,
        supportClearanceXY: 0.8,
        supportClearanceZ: 0.4,
        supportAutoPause: true,
        supportPauseLayers: '',
        pistonAutoPause: true,
        pistonCapacityMl: 500,
        pistonPauseThreshold: 90,
        supportParkX: 10,
        supportParkY: 10,
        supportParkLiftZ: 10.0,
        supportRetractDist: 2.5,
        supportPauseCommand: 'M0',
        startGcode: [
          'M104 S0 ; Disable hotend heater (Concrete Mode)',
          'M140 S0 ; Disable bed heater',
          'M302 P1 ; Allow cold extrusion for Auger Screw',
          'M203 E120 ; Unlock extruder max feedrate for direct auger metering',
          'M204 P250 T400 ; Controlled acceleration for heavy mass bead',
          'G28 ; Home all axes',
          'G1 Z10.0 F600 ; Lift nozzle safely before moving to start'
        ].join('\n'),
        endGcode: [
          'G91 ; Relative positioning',
          'G1 E-3.0 F900 ; Decompress auger screw to stop heavy cement ooze',
          'G1 Z15.0 F600 ; Lift Z above concrete print',
          'G90 ; Absolute positioning',
          'G1 X0 Y280 F3000 ; Present print forward on bed',
          'M84 ; Disable steppers'
        ].join('\n')
      }
    }
  ];

  // Default Mix Recipe from User Specification (500 ml Piston Cylinder Full Charge — Absolute Volume Method)
  // Exact physical volumes V_i = m_i / rho_i sum to 500.00 ml (Wet Paste Density = 2.095 g/ml, Open Time = 90–120 min):
  //   - Cement (OPC, ρ=3.15 g/ml)         : 800.00 g -> 253.97 ml (100.00% bwoc)
  //   - Water (ρ=1.00 g/ml)               : 237.78 g -> 237.78 ml (W/C = 0.2972)
  //   - Citric Acid (Retarder, ρ=1.665)   :   2.00 g ->   1.20 ml (0.250% bwoc -> 1.5–2.0h working time)
  //   - Superplasticizer (PCE, ρ=1.08)    :   6.50 g ->   6.02 ml (0.813% bwoc)
  //   - HPMC (Water Retainer, ρ=1.26)     :   1.30 g ->   1.03 ml (0.163% bwoc)
  //   TOTAL                               : 1047.58 g -> 500.00 ml
  const DEFAULT_RECIPES = [
    {
      id: 'default_cr10_paste_v1',
      name: '500ml Retarded Paste (90–120m Open Time)',
      cylinderVolumeMl: 500,
      notes: 'Exact 500.00ml absolute-volume cement paste with 0.25% bwoc Citric Acid for 1.5–2h working time, PCE superplasticizer, and HPMC water retainer.',
      ingredients: [
        { name: 'Cement (OPC)', weightGrams: 800.00, densityGPerMl: 3.15, unit: 'g' },
        { name: 'Water', weightGrams: 237.78, densityGPerMl: 1.00, unit: 'g (ml)' },
        { name: 'Citric Acid (Retarder)', weightGrams: 2.00, densityGPerMl: 1.665, unit: 'g' },
        { name: 'Superplasticizer (PCE)', weightGrams: 6.50, densityGPerMl: 1.08, unit: 'g' },
        { name: 'HPMC (Water Retainer)', weightGrams: 1.30, densityGPerMl: 1.26, unit: 'g' }
      ]
    },
    {
      id: 'high_buildability_paste',
      name: '500ml High-Buildability Paste (90–120m · Low W/C)',
      cylinderVolumeMl: 500,
      notes: 'Exact 500.00ml paste with lower W/C (0.285) and higher HPMC (0.184% bwoc) for tall single-wall / spiral vase prints with 1.5–2h open time.',
      ingredients: [
        { name: 'Cement (OPC)', weightGrams: 815.00, densityGPerMl: 3.15, unit: 'g' },
        { name: 'Water', weightGrams: 232.18, densityGPerMl: 1.00, unit: 'g (ml)' },
        { name: 'Citric Acid (Retarder)', weightGrams: 2.05, densityGPerMl: 1.665, unit: 'g' },
        { name: 'Superplasticizer (PCE)', weightGrams: 7.20, densityGPerMl: 1.08, unit: 'g' },
        { name: 'HPMC (Water Retainer)', weightGrams: 1.50, densityGPerMl: 1.26, unit: 'g' }
      ]
    }
  ];

  // Application State
  const state = {
    modelName: '',
    rawMesh: null,
    transformedMesh: null,
    sliceResult: null,
    hasSliced: false,
    supportResult: null,
    hasSlicedWithSupport: false,
    transform: {
      posX: 0,
      posY: 0,
      scaleX: 100,
      scaleY: 100,
      scaleZ: 100,
      rotX: 0,
      rotY: 0,
      rotZ: 0,
      uniformScale: true
    },
    presets: [],
    activePresetId: '',
    isPresetModified: false,
    settings: {
      // Printer & Hardware
      bedX: 300,
      bedY: 300,
      bedZ: 380,
      nozzleDiameter: 5, // 4, 5, 7, 10 mm
      ptfeInnerDia: 6.0, // 6 mm ID PTFE tube
      ptfeLengthMm: 800, // Tube length for dead-volume calculation
      includeTubeInMixCalc: false,
      materialType: 'concrete',
      // Print Mode: 'standard' | 'single_wall' | 'spiral_vase'
      printMode: 'standard',
      // Quality
      layerHeight: 2.5,
      firstLayerHeight: 2.5,
      lineWidth: 5.0,
      outerWallWidth: 5.0,
      innerWallWidth: 5.0,
      infillLineWidth: 5.0,
      crossSectionModel: 'capsule',
      // Strength / Shell
      wallCount: 2,
      topSurfacePattern: 'monotonic',
      topLayers: 2,
      bottomSurfacePattern: 'monotonic',
      bottomLayers: 2,
      internalSolidInfillPattern: 'match_surface',
      infillDensity: 15,
      infillPattern: 'grid',
      seamPosition: 'aligned',
      singleWallIncludeInnerHoles: true,
      vaseBottomLayer: true,
      // Speed (mm/s)
      printSpeed: 25,
      firstLayerSpeed: 25,
      outerWallSpeed: 25,
      innerWallSpeed: 25,
      infillSpeed: 25,
      travelSpeed: 80,
      printAcceleration: 300,
      // Extruder / Auger E-axis
      flowRatio: 1.0,
      eAxisMode: 'filament', // 'filament' | 'mm_per_ml' | 'volumetric'
      equivFilamentDia: 1.75,
      augerMmPerMl: 10.0,
      retractEnabled: true,
      retractDistance: 1.5,
      retractSpeed: 15,
      zHop: 1.5,
      // Support & Manual Layer Pause
      enableSupport: false,
      supportOverhangAngle: 30,
      supportWallThickness: 3.5,
      supportClearanceXY: 0.8,
      supportClearanceZ: 0.4,
      supportAutoPause: true,
      supportPauseLayers: '',
      pistonAutoPause: true,
      pistonCapacityMl: 500,
      pistonPauseThreshold: 90,
      supportParkX: 10,
      supportParkY: 10,
      supportParkLiftZ: 10.0,
      supportRetractDist: 2.5,
      supportPauseCommand: 'M0',
      // G-code
      startGcode: [
        'M104 S0 ; Disable hotend heater (Concrete Mode)',
        'M140 S0 ; Disable bed heater',
        'M302 P1 ; Allow cold extrusion for Auger Screw',
        'M204 P300 T500 ; Set gentle acceleration for heavy auger head',
        'G28 ; Home all axes',
        'G1 Z10.0 F600 ; Lift nozzle safely before moving to start'
      ].join('\n'),
      endGcode: [
        'G91 ; Relative positioning',
        'G1 E-2.5 F900 ; Decompress auger screw to stop cement ooze',
        'G1 Z15.0 F600 ; Lift Z above concrete print',
        'G90 ; Absolute positioning',
        'G1 X0 Y280 F3000 ; Present print forward on bed',
        'M84 ; Disable steppers'
      ].join('\n')
    },
    recipes: [],
    activeRecipeId: '',
    currentRecipe: null
  };

  let viewport = null;

  // =========================================================================
  // TOAST NOTIFICATION & SETTING PRESETS (OrcaSlicer Process Style)
  // =========================================================================

  function showToast(message) {
    let toast = document.getElementById('cim-toast-notification');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'cim-toast-notification';
      toast.className = 'cim-toast';
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.classList.add('show');
    if (toast._timer) clearTimeout(toast._timer);
    toast._timer = setTimeout(() => {
      toast.classList.remove('show');
    }, 2400);
  }

  function applyPresetSettings(targetSettings) {
    if (!targetSettings) return;
    const defaults = {
      enableSupport: false,
      supportOverhangAngle: 30,
      supportWallThickness: 3.5,
      supportClearanceXY: 0.8,
      supportClearanceZ: 0.4,
      supportAutoPause: true,
      supportPauseLayers: '',
      supportParkX: 10,
      supportParkY: 10,
      supportParkLiftZ: 10.0,
      supportRetractDist: 2.5,
      supportPauseCommand: 'M0'
    };
    for (const [k, v] of Object.entries(defaults)) {
      if (targetSettings[k] === undefined && state.settings[k] === undefined) {
        state.settings[k] = v;
      }
    }
    for (const key of Object.keys(targetSettings)) {
      state.settings[key] = targetSettings[key];
    }
    if (state.settings.materialType !== 'ceramic' && state.settings.materialType !== 'concrete') {
      state.settings.materialType = 'concrete';
    }
    syncSettingsToUI();
    if (viewport && viewport.setBedSize) {
      viewport.setBedSize(state.settings.bedX, state.settings.bedY, state.settings.bedZ);
    }
  }

  function loadPresetsFromStorage() {
    state.presets = JSON.parse(JSON.stringify(DEFAULT_PRESETS));
    try {
      const saved = appStorage.getItem(STORAGE_KEY_PRESETS);
      if (saved) {
        const userPresets = JSON.parse(saved);
        if (Array.isArray(userPresets)) {
          for (const up of userPresets) {
            if (up && up.id && !state.presets.some(p => p.id === up.id)) {
              up.isDefault = false;
              state.presets.push(up);
            }
          }
        }
      }
    } catch (e) {
      console.warn('Could not read saved presets:', e);
    }

    const savedActiveId = appStorage.getItem(STORAGE_KEY_ACTIVE_PRESET);
    const found = state.presets.find(p => p.id === savedActiveId) || state.presets[0];
    state.activePresetId = found.id;

    // Check if customized active settings were saved before app was closed
    let restoredSettings = null;
    try {
      const savedSettings = appStorage.getItem(STORAGE_KEY_CURRENT_SETTINGS);
      if (savedSettings) {
        restoredSettings = JSON.parse(savedSettings);
      }
    } catch (e) {}

    const isModSaved = appStorage.getItem(STORAGE_KEY_IS_PRESET_MODIFIED) === 'true';
    if (restoredSettings && isModSaved) {
      applyPresetSettings(restoredSettings);
      state.isPresetModified = true;
    } else {
      state.isPresetModified = false;
      applyPresetSettings(found.settings);
    }

    // Strictly enforce Support OFF by default on application startup
    state.settings.enableSupport = false;
    state.settings.supportPauseLayers = '';
    state.hasSlicedWithSupport = false;
    state.supportResult = null;
  }

  function savePresetsToStorage() {
    try {
      const userPresets = state.presets.filter(p => !p.isDefault);
      appStorage.setItem(STORAGE_KEY_PRESETS, JSON.stringify(userPresets));
      appStorage.setItem(STORAGE_KEY_ACTIVE_PRESET, state.activePresetId);
      appStorage.setItem(STORAGE_KEY_CURRENT_SETTINGS, JSON.stringify(state.settings));
      appStorage.setItem(STORAGE_KEY_IS_PRESET_MODIFIED, state.isPresetModified ? 'true' : 'false');
    } catch (e) {
      console.warn('Could not persist presets:', e);
    }
  }

  function renderPresetSelector() {
    const select = document.getElementById('setting-preset-select');
    const userGroup = document.getElementById('optgroup-user-presets');
    const sysGroup = document.getElementById('optgroup-system-presets');
    if (!select || !userGroup || !sysGroup) return;

    userGroup.innerHTML = '';
    sysGroup.innerHTML = '';

    const userPresets = state.presets.filter(p => !p.isDefault);
    const sysPresets = state.presets.filter(p => p.isDefault);

    if (userPresets.length === 0) {
      const emptyOpt = document.createElement('option');
      emptyOpt.disabled = true;
      emptyOpt.textContent = '(No user presets yet)';
      userGroup.appendChild(emptyOpt);
    } else {
      for (const p of userPresets) {
        const opt = document.createElement('option');
        opt.value = p.id;
        const prefix = (p.id === state.activePresetId && state.isPresetModified) ? '* ' : '';
        opt.textContent = prefix + p.name;
        userGroup.appendChild(opt);
      }
    }

    for (const p of sysPresets) {
      const opt = document.createElement('option');
      opt.value = p.id;
      const prefix = (p.id === state.activePresetId && state.isPresetModified) ? '* ' : '';
      opt.textContent = prefix + p.name;
      sysGroup.appendChild(opt);
    }

    select.value = state.activePresetId;

    // Delete button status: disabled for system presets
    const active = state.presets.find(p => p.id === state.activePresetId);
    const deleteBtn = document.getElementById('btn-delete-preset');
    if (deleteBtn && active) {
      deleteBtn.disabled = Boolean(active.isDefault);
      deleteBtn.style.opacity = active.isDefault ? '0.35' : '1.0';
      deleteBtn.title = active.isDefault ? 'System presets cannot be deleted' : 'Delete active user preset';
    }
  }

  function loadPreset(presetId, triggerSlice = true) {
    const preset = state.presets.find(p => p.id === presetId);
    if (!preset) return;
    state.activePresetId = preset.id;
    state.isPresetModified = false;
    applyPresetSettings(preset.settings);
    renderPresetSelector();
    savePresetsToStorage();
    showToast(`Preset "${preset.name}" loaded`);
    if (triggerSlice && state.hasSliced) {
      runSlicer({ reason: 'preset_change' });
    } else {
      updateStatsAndMixDisplay();
    }
  }

  // =========================================================================
  // ACHROMATIC IN-APP DIALOG SYSTEM (Prompt / Confirm / Alert)
  // Replaces window.prompt/confirm/alert for seamless Electron & Browser support
  // =========================================================================

  function showCIMPrompt({ title = 'Save Preset', message = 'Enter preset name:', defaultValue = '', confirmText = 'Save', cancelText = 'Cancel' }) {
    return new Promise(resolve => {
      const modal = document.getElementById('cim-dialog-modal');
      const titleEl = document.getElementById('cim-dialog-title');
      const msgEl = document.getElementById('cim-dialog-message');
      const inputEl = document.getElementById('cim-dialog-input');
      const btnConfirm = document.getElementById('cim-dialog-btn-confirm');
      const btnCancel = document.getElementById('cim-dialog-btn-cancel');
      const btnClose = document.getElementById('cim-dialog-close');

      titleEl.textContent = title;
      msgEl.textContent = message;
      inputEl.style.display = 'block';
      inputEl.value = defaultValue;
      btnConfirm.textContent = confirmText;
      btnCancel.style.display = 'inline-block';
      btnCancel.textContent = cancelText;

      const cleanup = () => {
        modal.classList.remove('active');
        btnConfirm.onclick = null;
        btnCancel.onclick = null;
        btnClose.onclick = null;
        inputEl.onkeydown = null;
      };

      btnConfirm.onclick = () => {
        const val = inputEl.value;
        cleanup();
        resolve(val);
      };

      btnCancel.onclick = () => {
        cleanup();
        resolve(null);
      };

      btnClose.onclick = () => {
        cleanup();
        resolve(null);
      };

      inputEl.onkeydown = e => {
        if (e.key === 'Enter') {
          e.preventDefault();
          btnConfirm.click();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          btnCancel.click();
        }
      };

      modal.classList.add('active');
      setTimeout(() => {
        inputEl.focus();
        inputEl.select();
      }, 50);
    });
  }

  function showCIMConfirm({ title = 'Confirm', message = '', confirmText = 'Delete', cancelText = 'Cancel' }) {
    return new Promise(resolve => {
      const modal = document.getElementById('cim-dialog-modal');
      const titleEl = document.getElementById('cim-dialog-title');
      const msgEl = document.getElementById('cim-dialog-message');
      const inputEl = document.getElementById('cim-dialog-input');
      const btnConfirm = document.getElementById('cim-dialog-btn-confirm');
      const btnCancel = document.getElementById('cim-dialog-btn-cancel');
      const btnClose = document.getElementById('cim-dialog-close');

      titleEl.textContent = title;
      msgEl.textContent = message;
      inputEl.style.display = 'none';
      btnConfirm.textContent = confirmText;
      btnCancel.style.display = 'inline-block';
      btnCancel.textContent = cancelText;

      const cleanup = () => {
        modal.classList.remove('active');
        btnConfirm.onclick = null;
        btnCancel.onclick = null;
        btnClose.onclick = null;
      };

      btnConfirm.onclick = () => {
        cleanup();
        resolve(true);
      };

      btnCancel.onclick = () => {
        cleanup();
        resolve(false);
      };

      btnClose.onclick = () => {
        cleanup();
        resolve(false);
      };

      modal.classList.add('active');
    });
  }

  function showCIMAlert({ title = 'Notice', message = '', html = '', wide = false, confirmText = 'OK' }) {
    return new Promise(resolve => {
      const modal = document.getElementById('cim-dialog-modal');
      const card = modal ? modal.querySelector('.cim-dialog-card') : null;
      const titleEl = document.getElementById('cim-dialog-title');
      const msgEl = document.getElementById('cim-dialog-message');
      const inputEl = document.getElementById('cim-dialog-input');
      const btnConfirm = document.getElementById('cim-dialog-btn-confirm');
      const btnCancel = document.getElementById('cim-dialog-btn-cancel');
      const btnClose = document.getElementById('cim-dialog-close');

      if (card) card.classList.toggle('wide', Boolean(wide));
      titleEl.textContent = title;
      if (html) {
        msgEl.innerHTML = html;
      } else {
        msgEl.textContent = message;
      }
      inputEl.style.display = 'none';
      btnConfirm.textContent = confirmText;
      btnCancel.style.display = 'none';

      const cleanup = () => {
        if (card) card.classList.remove('wide');
        modal.classList.remove('active');
        btnConfirm.onclick = null;
        btnCancel.onclick = null;
        btnClose.onclick = null;
      };

      btnConfirm.onclick = () => {
        cleanup();
        resolve(true);
      };

      btnClose.onclick = () => {
        cleanup();
        resolve(true);
      };

      modal.classList.add('active');
    });
  }

  async function saveCurrentToPreset(isNew = false) {
    const active = state.presets.find(p => p.id === state.activePresetId) || state.presets[0];
    if (isNew || active.isDefault) {
      const defaultName = active.isDefault ? `${active.name} (Custom)` : `${active.name} (Copy)`;
      const name = await showCIMPrompt({
        title: isNew ? 'Save New User Preset' : 'Save As User Preset',
        message: 'Enter a name for this User Preset:',
        defaultValue: defaultName,
        confirmText: 'Save'
      });
      if (!name || !name.trim()) return;

      const newId = 'user_preset_' + Date.now();
      const newPreset = {
        id: newId,
        name: name.trim(),
        isDefault: false,
        settings: JSON.parse(JSON.stringify(state.settings))
      };
      state.presets.push(newPreset);
      state.activePresetId = newId;
      state.isPresetModified = false;
      savePresetsToStorage();
      renderPresetSelector();
      showToast(`User Preset "${newPreset.name}" saved!`);
    } else {
      active.settings = JSON.parse(JSON.stringify(state.settings));
      state.isPresetModified = false;
      savePresetsToStorage();
      renderPresetSelector();
      showToast(`Preset "${active.name}" updated!`);
    }
  }

  async function deleteActivePreset() {
    const active = state.presets.find(p => p.id === state.activePresetId);
    if (!active) return;
    if (active.isDefault) {
      await showCIMAlert({
        title: 'System Preset',
        message: 'System presets cannot be deleted. Only user presets can be deleted.'
      });
      return;
    }
    const confirmed = await showCIMConfirm({
      title: 'Delete User Preset',
      message: `Are you sure you want to delete user preset "${active.name}"?`,
      confirmText: 'Delete'
    });
    if (confirmed) {
      state.presets = state.presets.filter(p => p.id !== active.id);
      state.activePresetId = state.presets[0].id;
      state.isPresetModified = false;
      savePresetsToStorage();
      loadPreset(state.activePresetId, true);
      showToast(`Preset "${active.name}" deleted.`);
    }
  }

  function exportActivePreset() {
    const active = state.presets.find(p => p.id === state.activePresetId) || state.presets[0];
    const exportData = {
      app: 'CIM Slicer 0.4.0',
      version: '0.4.0',
      type: 'user_preset',
      timestamp: new Date().toISOString(),
      preset: {
        name: active.name,
        settings: JSON.parse(JSON.stringify(state.settings))
      }
    };
    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const safeName = active.name.replace(/[^a-zA-Z0-9가-힣_-]/g, '_');
    a.download = `CIM_Preset_${safeName}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast(`Preset "${active.name}" exported to JSON!`);
  }

  function importPresetFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = e => {
      try {
        const json = JSON.parse(e.target.result);
        let importedSettings = null;
        let importedName = file.name.replace(/\.[^/.]+$/, '');

        if (json.preset && json.preset.settings) {
          importedSettings = json.preset.settings;
          if (json.preset.name) importedName = json.preset.name;
        } else if (json.settings) {
          importedSettings = json.settings;
          if (json.name) importedName = json.name;
        } else if (json.layerHeight !== undefined && json.nozzleDiameter !== undefined) {
          importedSettings = json;
        }

        if (!importedSettings) {
          showCIMAlert({
            title: 'Invalid Preset File',
            message: 'The selected file is not a valid CIM Slicer preset JSON format.'
          });
          return;
        }

        const newId = 'user_preset_' + Date.now();
        const newPreset = {
          id: newId,
          name: importedName,
          isDefault: false,
          settings: importedSettings
        };
        state.presets.push(newPreset);
        state.activePresetId = newId;
        state.isPresetModified = false;
        savePresetsToStorage();
        loadPreset(newId, true);
        showToast(`Preset "${importedName}" imported successfully!`);
      } catch (err) {
        showCIMAlert({
          title: 'Import Error',
          message: 'Error reading preset file: ' + err.message
        });
      }
    };
    reader.readAsText(file);
  }

  // =========================================================================
  // INITIALIZATION
  // =========================================================================

  window.addEventListener('DOMContentLoaded', () => {
    loadPresetsFromStorage();
    loadRecipesFromStorage();
    const canvas = document.getElementById('viewport-canvas');
    viewport = window.JihuViewport3D(canvas);

    bindUIEvents();
    syncSettingsToUI();
    renderPresetSelector();
    renderRecipeSelector();
    renderRecipeEditor();

    // Start cleanly in Prepare view with an empty bed
    setWorkspaceView('prepare');
    viewport.setMesh(null);
    viewport.setSliceResult(null);
    viewport.resize();
    viewport.resetCamera('iso');
    updateStatsAndMixDisplay();
  });

  function loadRecipesFromStorage() {
    try {
      const saved = appStorage.getItem(STORAGE_KEY_RECIPES);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) {
          state.recipes = parsed;
        }
      }
    } catch (e) {
      console.warn('Could not read saved recipes:', e);
    }

    if (!state.recipes || state.recipes.length === 0) {
      state.recipes = JSON.parse(JSON.stringify(DEFAULT_RECIPES));
    }

    const savedActiveId = appStorage.getItem(STORAGE_KEY_ACTIVE_RECIPE);
    const found = state.recipes.find(r => r.id === savedActiveId) || state.recipes[0];
    state.activeRecipeId = found.id;
    state.currentRecipe = JSON.parse(JSON.stringify(found));
  }

  function saveRecipesToStorage() {
    try {
      appStorage.setItem(STORAGE_KEY_RECIPES, JSON.stringify(state.recipes));
      appStorage.setItem(STORAGE_KEY_ACTIVE_RECIPE, state.activeRecipeId);
    } catch (e) {
      console.warn('Could not persist recipes:', e);
    }
  }

  // Auto-save on window exit / close
  window.addEventListener('beforeunload', () => {
    if (state.currentRecipe && state.activeRecipeId) {
      const idx = state.recipes.findIndex(r => r.id === state.activeRecipeId);
      if (idx !== -1) {
        state.recipes[idx] = JSON.parse(JSON.stringify(state.currentRecipe));
      }
    }
    savePresetsToStorage();
    saveRecipesToStorage();
  });

  // =========================================================================
  // UI BINDINGS
  // =========================================================================

  function bindUIEvents() {
    // Workspace Top Tabs (Prepare / Preview)
    document.querySelectorAll('.workspace-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        const mode = btn.dataset.view;
        setWorkspaceView(mode);
      });
    });

    // Left Sidebar Category Tabs
    document.querySelectorAll('.param-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.param-tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
        tab.classList.add('active');
        const target = document.getElementById(tab.dataset.tab);
        if (target) target.classList.add('active');
      });
    });

    // Process Preset Selector & Actions (OrcaSlicer Style)
    const presetSelect = document.getElementById('setting-preset-select');
    if (presetSelect) {
      presetSelect.addEventListener('change', e => {
        loadPreset(e.target.value, true);
      });
    }

    const btnSavePreset = document.getElementById('btn-save-preset');
    if (btnSavePreset) {
      btnSavePreset.addEventListener('click', () => {
        saveCurrentToPreset(false);
      });
    }

    const btnSaveAsPreset = document.getElementById('btn-save-as-preset');
    if (btnSaveAsPreset) {
      btnSaveAsPreset.addEventListener('click', () => {
        saveCurrentToPreset(true);
      });
    }

    const btnDeletePreset = document.getElementById('btn-delete-preset');
    if (btnDeletePreset) {
      btnDeletePreset.addEventListener('click', () => {
        deleteActivePreset();
      });
    }

    const btnExportPreset = document.getElementById('btn-export-preset');
    if (btnExportPreset) {
      btnExportPreset.addEventListener('click', () => {
        exportActivePreset();
      });
    }

    const btnImportPreset = document.getElementById('btn-import-preset');
    const fileImportPreset = document.getElementById('file-import-preset');
    if (btnImportPreset && fileImportPreset) {
      btnImportPreset.addEventListener('click', () => {
        fileImportPreset.click();
      });
      fileImportPreset.addEventListener('change', e => {
        if (e.target.files && e.target.files[0]) {
          importPresetFile(e.target.files[0]);
          fileImportPreset.value = '';
        }
      });
    }

    // Print Mode Cards (Standard, Single Outer Wall, Spiralize Vase)
    document.querySelectorAll('.mode-card[data-mode]').forEach(card => {
      card.addEventListener('click', () => {
        const mode = card.dataset.mode;
        applyPrintMode(mode);
      });
    });

    // Material Type Cards (Concrete / Ceramic)
    document.querySelectorAll('.material-type-card[data-material-type]').forEach(card => {
      card.addEventListener('click', () => {
        applyMaterialType(card.dataset.materialType);
      });
    });

    // Bind all parameter inputs with data-setting attribute (live auto-reslice on change/input)
    let autoSliceTimer = null;
    const handleSettingChange = (el, isImmediate) => {
      const key = el.dataset.setting;
      if (el.type === 'checkbox') {
        state.settings[key] = el.checked;
      } else if (el.type === 'number') {
        const parsed = parseFloat(el.value);
        state.settings[key] = Number.isNaN(parsed) ? 0 : parsed;
      } else {
        state.settings[key] = el.value;
      }

      state.isPresetModified = true;
      renderPresetSelector();
      savePresetsToStorage();

      if (key === 'printSpeed') {
        const spd = Number(state.settings.printSpeed) || 25;
        state.settings.firstLayerSpeed = spd;
        state.settings.outerWallSpeed = spd;
        state.settings.innerWallSpeed = spd;
        state.settings.infillSpeed = spd;
      }
      if (key === 'lineWidth') {
        const lw = Number(state.settings.lineWidth) || 5.0;
        state.settings.nozzleDiameter = lw;
        state.settings.outerWallWidth = lw;
        state.settings.innerWallWidth = lw;
        state.settings.infillLineWidth = lw;
      }
      if (key === 'layerHeight') {
        const lh = Number(state.settings.layerHeight) || 2.5;
        state.settings.firstLayerHeight = lh;
      }

      updateShellThicknessReadouts();

      if (key === 'bedX' || key === 'bedY' || key === 'bedZ') {
        viewport.setBedSize(state.settings.bedX, state.settings.bedY, state.settings.bedZ);
        updateTransformedMesh();
      }
      if (key === 'eAxisMode') {
        updateEAxisModeVisibility();
      }
      if (key === 'pistonCapacityMl') {
        const targetVol = Math.max(10, Number(state.settings.pistonCapacityMl) || 500);
        if (state.currentRecipe) {
          state.currentRecipe.cylinderVolumeMl = targetVol;
        }
        const cylInput = document.getElementById('recipe-cylinder-vol');
        if (cylInput) cylInput.value = targetVol;
        const fitBtn = document.getElementById('btn-fit-cylinder-vol');
        if (fitBtn) fitBtn.textContent = `Fit ${targetVol}ml`;
        renderIngredientPercentages();
        saveRecipesToStorage();
      }
      if (key === 'includeTubeInMixCalc' || key === 'ptfeInnerDia' || key === 'ptfeLengthMm') {
        if (state.sliceResult) {
          const tubeIdMm = Math.max(1, Number(state.settings.ptfeInnerDia) || 6.0);
          const tubeLengthMm = Math.max(0, Number(state.settings.ptfeLengthMm) || 800);
          state.sliceResult.tubeDeadVolumeMl = (Math.PI * Math.pow(tubeIdMm * 0.5, 2) * tubeLengthMm) / 1000.0;
        }
        updateStatsAndMixDisplay();
        return;
      }
      if (key === 'startGcode' || key === 'endGcode') {
        return;
      }
      if (key === 'enableSupport') {
        if (!state.settings.enableSupport) {
          state.hasSlicedWithSupport = false;
          state.supportResult = null;
          if (viewport && viewport.setSupportMesh) {
            viewport.setSupportMesh(null);
          }
        }
        updateSupportUIState();
        return;
      }
      if (key === 'supportPauseLayers' || key.startsWith('support')) {
        updateSupportUIState();
        // If support hasn't been sliced yet via 'Slice Plate', wait until user slices
        if (!state.hasSlicedWithSupport && (
          key === 'supportOverhangAngle' ||
          key === 'supportWallThickness' ||
          key === 'supportClearanceXY' ||
          key === 'supportClearanceZ' ||
          key === 'supportAutoPause'
        )) {
          return;
        }
      }

      if (!state.hasSliced) {
        updateStatsAndMixDisplay();
        return;
      }

      if (autoSliceTimer) clearTimeout(autoSliceTimer);
      if (isImmediate) {
        runSlicer({ changedKey: key });
      } else {
        autoSliceTimer = setTimeout(() => {
          runSlicer({ changedKey: key });
        }, 120);
      }
    };

    document.querySelectorAll('[data-setting]').forEach(el => {
      el.addEventListener('change', () => handleSettingChange(el, true));
      if (el.type === 'number' || el.id === 'input-support-pause-layers') {
        el.addEventListener('input', () => handleSettingChange(el, false));
      }
    });

    const btnAddPause = document.getElementById('btn-add-current-layer-pause');
    if (btnAddPause) {
      btnAddPause.addEventListener('click', () => {
        const curLayer = playbackState.activeLayerIdx + 1;
        if (!state.settings.enableSupport) {
          state.settings.enableSupport = true;
          const chk = document.getElementById('chk-enable-support');
          if (chk) chk.checked = true;
        }
        addSupportPauseLayer(curLayer);
      });
    }

    const btnExportSupportStl = document.getElementById('btn-export-support-stl');
    if (btnExportSupportStl) {
      btnExportSupportStl.addEventListener('click', () => {
        exportSupportSTLFile();
      });
    }

    const chkShowSupportMesh = document.getElementById('chk-show-support-mesh');
    const chkPreviewShowSupport = document.getElementById('chk-preview-show-support');
    const syncSupportVisibility = visible => {
      if (chkShowSupportMesh) chkShowSupportMesh.checked = visible;
      if (chkPreviewShowSupport) chkPreviewShowSupport.checked = visible;
      if (viewport && viewport.setShowSupportMesh) {
        viewport.setShowSupportMesh(visible);
      }
    };
    if (chkShowSupportMesh) {
      chkShowSupportMesh.addEventListener('change', () => {
        syncSupportVisibility(chkShowSupportMesh.checked);
      });
    }
    if (chkPreviewShowSupport) {
      chkPreviewShowSupport.addEventListener('change', () => {
        syncSupportVisibility(chkPreviewShowSupport.checked);
      });
    }

    // Slice Button & Export G-code Button
    document.getElementById('btn-slice').addEventListener('click', () => {
      if (!state.rawMesh) {
        showCIMAlert({
          title: 'No Model Loaded',
          message: 'Please load a 3D model (STL/OBJ/3MF) or select a sample model first.'
        });
        return;
      }
      runSlicer({ switchView: true, fromExplicitSlice: true });
    });

    document.getElementById('btn-export-gcode').addEventListener('click', () => {
      exportGCodeFile();
    });

    document.getElementById('btn-inspect-gcode').addEventListener('click', () => {
      openGCodeModal();
    });

    document.getElementById('btn-close-modal').addEventListener('click', () => {
      document.getElementById('gcode-modal').classList.remove('active');
    });

    const btnAbout = document.getElementById('btn-about-app');
    if (btnAbout) {
      btnAbout.addEventListener('click', () => {
        showCIMAlert({
          title: 'CIM Slicer 0.4.0 — About & Guide',
          wide: true,
          html: `
            <div class="about-content">
              <div class="about-hero">
                <div class="about-hero-title">CIM Slicer 0.4.0 - Jihu Studio</div>
                <div class="about-hero-meta">Copyright &copy; 2026 Jihu Studio &middot; Open Source (MIT License) &middot; Concrete &amp; Ceramic 3D Printing Slicer</div>
              </div>

              <div class="about-section">
                <div class="about-section-title">Key Features</div>
                <div class="about-grid">
                  <div class="about-key">Material Modes</div>
                  <div class="about-val">Supports both Concrete (mix recipe &amp; batch weights) and Ceramic (volume, time &amp; piston capacity only).</div>
                  <div class="about-key">Extrusion Engine</div>
                  <div class="about-val">Constant-speed volumetric extrusion calculated from Line Width &amp; Layer Height across all print moves.</div>
                  <div class="about-key">Piston Auto-Pause</div>
                  <div class="about-val">Automatically inserts refill pauses when cumulative extrusion reaches 90% of piston cylinder capacity.</div>
                  <div class="about-key">Toolpath &amp; Support</div>
                  <div class="about-val">Standard, Single Wall &amp; Spiralize Vase modes, Medial Thin-Wall, 1D CSG Infill, and Adaptive Hollow Support.</div>
                </div>
              </div>

              <div class="about-section">
                <div class="about-section-title">How to Use</div>
                <div class="about-grid">
                  <div class="about-key">1. Prepare</div>
                  <div class="about-val">Load an STL / OBJ / 3MF model (or drag &amp; drop into the viewport) and adjust position, scale, and rotation.</div>
                  <div class="about-key">2. Configure</div>
                  <div class="about-val">Set Line Width, Layer Height, Speed, and choose Concrete or Ceramic in the Mix Recipe tab.</div>
                  <div class="about-key">3. Slice Plate</div>
                  <div class="about-val">Click <strong>Slice Plate</strong> to generate toolpaths, inspect layer preview, and view time &amp; material estimates.</div>
                  <div class="about-key">4. Export G-Code</div>
                  <div class="about-val">Click <strong>Export G-Code</strong> to save G-code for your concrete or ceramic printer.</div>
                </div>
              </div>

              <div class="about-section">
                <div class="about-section-title">Shortcuts &amp; Controls</div>
                <div class="about-grid">
                  <div class="about-key">Space</div>
                  <div class="about-val">Play / Pause nozzle path simulation</div>
                  <div class="about-key">&larr; / &rarr;</div>
                  <div class="about-val">Step back / forward 1 toolpath move</div>
                  <div class="about-key">Ctrl+1 / Ctrl+2</div>
                  <div class="about-val">Switch between Prepare and Preview workspaces</div>
                </div>
              </div>
            </div>
          `
        });
      });
    }

    // File Import (STL / OBJ)
    const fileInput = document.getElementById('file-input-stl');
    document.getElementById('btn-import-stl').addEventListener('click', () => {
      fileInput.click();
    });
    fileInput.addEventListener('change', e => {
      if (e.target.files && e.target.files[0]) {
        loadUserModelFile(e.target.files[0]);
        fileInput.value = '';
      }
    });

    // Built-in Test Models Selector
    document.getElementById('builtin-model-select').addEventListener('change', e => {
      const val = e.target.value;
      if (!val) return;
      const labels = {
        vase_twisted: 'Twisted_Concrete_Vase.stl',
        hollow_block: 'Hollow_Wall_Block_120x120.stl',
        cylinder: 'Test_Cylinder_100x120.stl',
        cube: 'Calibration_Block_100x100.stl'
      };
      loadBuiltinPrimitive(val, labels[val] || 'Test_Model.stl');
    });

    // Drag & Drop STL onto Viewport
    const viewportArea = document.querySelector('.viewport-area');
    const dropOverlay = document.getElementById('dropzone-overlay');
    viewportArea.addEventListener('dragover', e => {
      e.preventDefault();
      dropOverlay.classList.add('active');
    });
    viewportArea.addEventListener('dragleave', e => {
      if (e.target === viewportArea || !viewportArea.contains(e.relatedTarget)) {
        dropOverlay.classList.remove('active');
      }
    });
    viewportArea.addEventListener('drop', e => {
      e.preventDefault();
      dropOverlay.classList.remove('active');
      if (e.dataTransfer.files && e.dataTransfer.files[0]) {
        loadUserModelFile(e.dataTransfer.files[0]);
      }
    });

    // Transform Controls (Position, Scale, Rotation)
    const bindTransformInput = (id, key, isScale) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('input', () => {
        const val = parseFloat(el.value) || (isScale ? 100 : 0);
        if (isScale && state.transform.uniformScale) {
          state.transform.scaleX = val;
          state.transform.scaleY = val;
          state.transform.scaleZ = val;
          document.getElementById('tf-scale-x').value = val;
          document.getElementById('tf-scale-y').value = val;
          document.getElementById('tf-scale-z').value = val;
        } else {
          state.transform[key] = val;
        }
        updateTransformedMesh();
      });
    };

    bindTransformInput('tf-pos-x', 'posX', false);
    bindTransformInput('tf-pos-y', 'posY', false);
    bindTransformInput('tf-scale-x', 'scaleX', true);
    bindTransformInput('tf-scale-y', 'scaleY', true);
    bindTransformInput('tf-scale-z', 'scaleZ', true);
    bindTransformInput('tf-rot-x', 'rotX', false);
    bindTransformInput('tf-rot-y', 'rotY', false);
    bindTransformInput('tf-rot-z', 'rotZ', false);

    document.getElementById('tf-uniform-scale').addEventListener('change', e => {
      state.transform.uniformScale = e.target.checked;
    });

    document.getElementById('btn-center-model').addEventListener('click', () => {
      state.transform.posX = 0;
      state.transform.posY = 0;
      document.getElementById('tf-pos-x').value = 0;
      document.getElementById('tf-pos-y').value = 0;
      updateTransformedMesh();
    });

    document.getElementById('btn-reset-transform').addEventListener('click', () => {
      state.transform = {
        posX: 0, posY: 0,
        scaleX: 100, scaleY: 100, scaleZ: 100,
        rotX: 0, rotY: 0, rotZ: 0,
        uniformScale: true
      };
      document.getElementById('tf-pos-x').value = 0;
      document.getElementById('tf-pos-y').value = 0;
      document.getElementById('tf-scale-x').value = 100;
      document.getElementById('tf-scale-y').value = 100;
      document.getElementById('tf-scale-z').value = 100;
      document.getElementById('tf-rot-x').value = 0;
      document.getElementById('tf-rot-y').value = 0;
      document.getElementById('tf-rot-z').value = 0;
      document.getElementById('tf-uniform-scale').checked = true;
      updateTransformedMesh();
    });

    // Camera View Buttons
    document.getElementById('btn-cam-iso').addEventListener('click', () => viewport.resetCamera('iso'));
    document.getElementById('btn-cam-top').addEventListener('click', () => viewport.resetCamera('top'));
    document.getElementById('btn-cam-front').addEventListener('click', () => viewport.resetCamera('front'));

    // Interactive "Place on Face" (Select Face on 3D Model)
    const placeOnFaceBtn = document.getElementById('btn-place-on-face');
    if (placeOnFaceBtn) {
      placeOnFaceBtn.addEventListener('click', () => {
        setWorkspaceView('prepare');
        const nextActive = !viewport.isPlaceOnFaceActive();
        placeOnFaceBtn.classList.toggle('active', nextActive);
        placeOnFaceBtn.textContent = nextActive ? 'Click Any Face on Model (Cancel)' : 'Select Face on 3D Model';
        viewport.setPlaceOnFaceMode(nextActive, pickedTriIndex => {
          placeOnFaceBtn.classList.remove('active');
          placeOnFaceBtn.textContent = 'Select Face on 3D Model';
          viewport.setPlaceOnFaceMode(false, null);
          if (pickedTriIndex >= 0 && state.rawMesh) {
            const angles = window.JihuEngine.computeLayOnFaceRotation(state.rawMesh, pickedTriIndex, state.transform);
            state.transform.rotX = angles.rotX;
            state.transform.rotY = angles.rotY;
            state.transform.rotZ = angles.rotZ;
            document.getElementById('tf-rot-x').value = angles.rotX;
            document.getElementById('tf-rot-y').value = angles.rotY;
            document.getElementById('tf-rot-z').value = angles.rotZ;
            updateTransformedMesh();
          }
        });
      });
    }

    // Quick 6-Face Alignment Presets (Bottom, Top, Front, Back, Left, Right)
    document.querySelectorAll('.face-preset-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const face = btn.dataset.face;
        const presets = {
          bottom: { rx: 0, ry: 0, rz: 0 },
          top: { rx: 180, ry: 0, rz: 0 },
          front: { rx: -90, ry: 0, rz: 0 },
          back: { rx: 90, ry: 0, rz: 0 },
          left: { rx: 0, ry: -90, rz: 0 },
          right: { rx: 0, ry: 90, rz: 0 }
        };
        const p = presets[face];
        if (!p) return;
        state.transform.rotX = p.rx;
        state.transform.rotY = p.ry;
        state.transform.rotZ = p.rz;
        document.getElementById('tf-rot-x').value = p.rx;
        document.getElementById('tf-rot-y').value = p.ry;
        document.getElementById('tf-rot-z').value = p.rz;
        updateTransformedMesh();
      });
    });

    // Preview Display Mode Switcher (3D Bead Form / Motion Path / Hybrid X-Ray)
    document.querySelectorAll('.preview-style-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.preview-style-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        viewport.setPreviewOptions({ renderStyle: btn.dataset.pstyle });
      });
    });

    const colorSchemeSelect = document.getElementById('preview-color-scheme');
    if (colorSchemeSelect) {
      colorSchemeSelect.addEventListener('change', () => {
        viewport.setPreviewOptions({ colorScheme: colorSchemeSelect.value });
      });
    }

    // Layer Scrubber & Preview Toggles
    const layerSlider = document.getElementById('layer-slider');
    const moveSlider = document.getElementById('move-slider');
    const singleLayerCheck = document.getElementById('chk-single-layer');
    const showTravelCheck = document.getElementById('chk-show-travel');
    const showSeamsCheck = document.getElementById('chk-show-seams');
    const showGhostCheck = document.getElementById('chk-show-ghost');
    const btnPlayToggle = document.getElementById('btn-play-toggle');
    const btnPlayStepBack = document.getElementById('btn-play-step-back');
    const btnPlayStepForward = document.getElementById('btn-play-step-forward');
    const playSpeedSelect = document.getElementById('play-speed-select');
    const chkAutoAdvanceLayer = document.getElementById('chk-auto-advance-layer');

    layerSlider.addEventListener('input', () => {
      const idx = parseInt(layerSlider.value, 10) || 0;
      playbackState.activeLayerIdx = idx;
      updateLayerScrubberReadout(idx);
      viewport.setLayerFilter(idx, singleLayerCheck ? singleLayerCheck.checked : false);
      if (!playbackState.isPlaying && state.sliceResult && state.sliceResult.layers) {
        const curL = state.sliceResult.layers[idx];
        playbackState.activeMoveIdx = curL && curL.moves ? Math.max(0, curL.moves.length - 1) : 0;
        playbackState.activeFraction = 1.0;
        updateMoveScrubberAndHUD(idx, playbackState.activeMoveIdx, 1.0);
      }
    });

    if (moveSlider) {
      moveSlider.addEventListener('input', () => {
        pausePlayback();
        if (!state.sliceResult || !state.sliceResult.layers) return;
        const curL = state.sliceResult.layers[playbackState.activeLayerIdx];
        if (!curL || !curL.moves || curL.moves.length === 0) return;
        const totalMoves = curL.moves.length;
        const val = parseInt(moveSlider.value, 10) || 0;
        const prog = (val / 1000) * totalMoves;
        playbackState.activeMoveIdx = Math.min(totalMoves - 1, Math.floor(prog));
        playbackState.activeFraction = Math.max(0, Math.min(1.0, prog - playbackState.activeMoveIdx));
        updateMoveScrubberAndHUD(playbackState.activeLayerIdx, playbackState.activeMoveIdx, playbackState.activeFraction);
      });
    }

    if (btnPlayToggle) {
      btnPlayToggle.addEventListener('click', () => {
        togglePlayback();
      });
    }

    if (btnPlayStepBack) {
      btnPlayStepBack.addEventListener('click', () => {
        stepPlayback(-1);
      });
    }

    if (btnPlayStepForward) {
      btnPlayStepForward.addEventListener('click', () => {
        stepPlayback(1);
      });
    }

    if (playSpeedSelect) {
      playSpeedSelect.addEventListener('change', () => {
        playbackState.speedMultiplier = parseFloat(playSpeedSelect.value) || 1.0;
      });
    }

    if (chkAutoAdvanceLayer) {
      chkAutoAdvanceLayer.addEventListener('change', () => {
        playbackState.autoAdvanceLayer = chkAutoAdvanceLayer.checked;
      });
    }

    // Keyboard Shortcuts for Simulation & Layer Navigation
    window.addEventListener('keydown', e => {
      // Don't intercept when user is typing inside an input or textarea
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
      if (currentViewMode !== 'preview') return;

      if (e.code === 'Space') {
        e.preventDefault();
        togglePlayback();
      } else if (e.code === 'ArrowLeft') {
        e.preventDefault();
        stepPlayback(e.shiftKey ? -10 : -1);
      } else if (e.code === 'ArrowRight') {
        e.preventDefault();
        stepPlayback(e.shiftKey ? 10 : 1);
      } else if (e.code === 'ArrowUp') {
        e.preventDefault();
        const cur = parseInt(layerSlider.value, 10) || 0;
        const next = Math.min(parseInt(layerSlider.max, 10) || 0, cur + 1);
        if (next !== cur) {
          layerSlider.value = next;
          layerSlider.dispatchEvent(new Event('input'));
        }
      } else if (e.code === 'ArrowDown') {
        e.preventDefault();
        const cur = parseInt(layerSlider.value, 10) || 0;
        const prev = Math.max(0, cur - 1);
        if (prev !== cur) {
          layerSlider.value = prev;
          layerSlider.dispatchEvent(new Event('input'));
        }
      }
    });

    singleLayerCheck.addEventListener('change', () => {
      const idx = parseInt(layerSlider.value, 10) || 0;
      viewport.setLayerFilter(idx, singleLayerCheck.checked);
    });

    showTravelCheck.addEventListener('change', () => {
      viewport.setPreviewOptions({ showTravel: showTravelCheck.checked });
    });

    if (showSeamsCheck) {
      showSeamsCheck.addEventListener('change', () => {
        viewport.setPreviewOptions({ showSeams: showSeamsCheck.checked });
      });
    }

    showGhostCheck.addEventListener('change', () => {
      viewport.setPreviewOptions({ showGhost: showGhostCheck.checked });
    });

    // =======================================================================
    // MATERIAL / MIX RECIPE MANAGER EVENTS
    // =======================================================================
    document.getElementById('recipe-select').addEventListener('change', e => {
      const id = e.target.value;
      const found = state.recipes.find(r => r.id === id);
      if (found) {
        state.activeRecipeId = found.id;
        state.currentRecipe = JSON.parse(JSON.stringify(found));
        if (state.settings.materialType !== 'ceramic') {
          const targetVol = Math.max(10, Number(state.currentRecipe.cylinderVolumeMl) || 500);
          state.settings.pistonCapacityMl = targetVol;
          const pistonInput = document.querySelector('[data-setting="pistonCapacityMl"]');
          if (pistonInput) pistonInput.value = targetVol;
          savePresetsToStorage();
        }
        saveRecipesToStorage();
        renderRecipeEditor();
        updateStatsAndMixDisplay();
      }
    });

    document.getElementById('recipe-name-input').addEventListener('input', e => {
      state.currentRecipe.name = e.target.value;
      updateStatsAndMixDisplay();
    });

    document.getElementById('recipe-cylinder-vol').addEventListener('input', e => {
      const targetVol = Math.max(10, parseFloat(e.target.value) || 500);
      if (state.currentRecipe) {
        state.currentRecipe.cylinderVolumeMl = targetVol;
      }
      state.settings.pistonCapacityMl = targetVol;
      const pistonInput = document.querySelector('[data-setting="pistonCapacityMl"]');
      if (pistonInput) pistonInput.value = targetVol;
      savePresetsToStorage();
      saveRecipesToStorage();
      const fitBtn = document.getElementById('btn-fit-cylinder-vol');
      if (fitBtn) fitBtn.textContent = `Fit ${targetVol}ml`;
      renderIngredientPercentages();
      if (state.hasSliced) {
        if (autoSliceTimer) clearTimeout(autoSliceTimer);
        autoSliceTimer = setTimeout(() => {
          runSlicer({ changedKey: 'pistonCapacityMl' });
        }, 120);
      } else {
        updateStatsAndMixDisplay();
      }
    });

    const fitVolBtn = document.getElementById('btn-fit-cylinder-vol');
    if (fitVolBtn) {
      fitVolBtn.addEventListener('click', () => {
        if (!state.currentRecipe || !Array.isArray(state.currentRecipe.ingredients)) return;
        const targetVol = Math.max(10, Number(state.currentRecipe.cylinderVolumeMl) || 500);
        let curVol = 0;
        for (const ing of state.currentRecipe.ingredients) {
          const w = Math.max(0, Number(ing.weightGrams) || 0);
          const rho = (window.JihuEngine && window.JihuEngine.inferIngredientDensityGPerMl)
            ? window.JihuEngine.inferIngredientDensityGPerMl(ing.name, ing.densityGPerMl)
            : (Number(ing.densityGPerMl) || 2.0);
          curVol += rho > 0 ? w / rho : 0;
        }
        if (curVol > 1e-4) {
          const factor = targetVol / curVol;
          for (const ing of state.currentRecipe.ingredients) {
            const w = Math.max(0, Number(ing.weightGrams) || 0);
            ing.weightGrams = Number((w * factor).toFixed(2));
          }
          renderRecipeEditor();
          updateStatsAndMixDisplay();
          showToast(`Recipe weights scaled to exact ${targetVol.toFixed(1)} ml absolute volume`);
        }
      });
    }

    document.getElementById('btn-add-ingredient').addEventListener('click', () => {
      state.currentRecipe.ingredients.push({
        name: 'New Additive',
        weightGrams: 1.0,
        densityGPerMl: 1.20,
        unit: 'g'
      });
      renderRecipeEditor();
      updateStatsAndMixDisplay();
    });

    document.getElementById('btn-save-recipe').addEventListener('click', () => {
      saveCurrentRecipe(false);
    });

    document.getElementById('btn-save-new-recipe').addEventListener('click', () => {
      saveCurrentRecipe(true);
    });

    document.getElementById('btn-delete-recipe').addEventListener('click', async () => {
      if (state.recipes.length <= 1) {
        await showCIMAlert({
          title: 'Recipe Manager',
          message: 'At least one Mix Recipe must remain in CIM Slicer.'
        });
        return;
      }
      const confirmed = await showCIMConfirm({
        title: 'Delete Mix Recipe',
        message: `Are you sure you want to delete recipe "${state.currentRecipe.name}"?`,
        confirmText: 'Delete'
      });
      if (!confirmed) return;
      state.recipes = state.recipes.filter(r => r.id !== state.activeRecipeId);
      state.activeRecipeId = state.recipes[0].id;
      state.currentRecipe = JSON.parse(JSON.stringify(state.recipes[0]));
      saveRecipesToStorage();
      renderRecipeSelector();
      renderRecipeEditor();
      updateStatsAndMixDisplay();
    });

    document.getElementById('btn-reset-default-recipe').addEventListener('click', () => {
      state.currentRecipe = JSON.parse(JSON.stringify(DEFAULT_RECIPES[0]));
      state.currentRecipe.id = state.activeRecipeId;
      saveCurrentRecipe(false);
    });
  }

  // =========================================================================
  // PRINT MODE PRESETS
  // =========================================================================

  function applyPrintMode(mode) {
    state.settings.printMode = mode;
    state.isPresetModified = true;
    renderPresetSelector();

    document.querySelectorAll('.mode-card[data-mode]').forEach(c => {
      c.classList.toggle('active', c.dataset.mode === mode);
    });

    // Update mode-dependent fields in Strength tab
    const standardGroup = document.getElementById('group-standard-strength');
    const singleWallGroup = document.getElementById('group-single-wall-opts');
    const vaseGroup = document.getElementById('group-vase-opts');

    if (standardGroup) standardGroup.style.display = mode === 'standard' ? 'flex' : 'none';
    if (singleWallGroup) singleWallGroup.style.display = mode === 'single_wall' ? 'flex' : 'none';
    if (vaseGroup) vaseGroup.style.display = mode === 'spiral_vase' ? 'flex' : 'none';

    if (state.hasSliced) {
      runSlicer();
    } else {
      updateStatsAndMixDisplay();
    }
  }

  function updateMaterialTypeUI() {
    const matType = state.settings.materialType === 'ceramic' ? 'ceramic' : 'concrete';
    const isCeramic = matType === 'ceramic';

    document.querySelectorAll('.material-type-card[data-material-type]').forEach(card => {
      card.classList.toggle('active', card.dataset.materialType === matType);
    });

    const concreteHeader = document.getElementById('concrete-recipe-header-group');
    const batchGroup = document.getElementById('group-mix-batch-composition');
    const computedGroup = document.getElementById('group-mix-computed-properties');

    if (concreteHeader) concreteHeader.style.display = isCeramic ? 'none' : 'flex';
    if (batchGroup) batchGroup.style.display = isCeramic ? 'none' : 'flex';
    if (computedGroup) computedGroup.style.display = isCeramic ? 'none' : 'flex';

    const cylVolInput = document.getElementById('recipe-cylinder-vol');
    if (cylVolInput) {
      const targetCylVol = isCeramic
        ? (Number(state.settings.pistonCapacityMl) || Number(state.currentRecipe && state.currentRecipe.cylinderVolumeMl) || 500)
        : (Number(state.currentRecipe && state.currentRecipe.cylinderVolumeMl) || Number(state.settings.pistonCapacityMl) || 500);
      cylVolInput.value = targetCylVol;
    }
  }

  function applyMaterialType(matType) {
    const normalized = matType === 'ceramic' ? 'ceramic' : 'concrete';
    state.settings.materialType = normalized;
    if (normalized === 'ceramic') {
      const cap = Number(state.settings.pistonCapacityMl) || Number(state.currentRecipe && state.currentRecipe.cylinderVolumeMl) || 500;
      state.settings.pistonCapacityMl = cap;
      if (state.currentRecipe) state.currentRecipe.cylinderVolumeMl = cap;
    } else if (state.currentRecipe && state.currentRecipe.cylinderVolumeMl) {
      state.settings.pistonCapacityMl = Number(state.currentRecipe.cylinderVolumeMl) || 500;
    }

    const supportCapInput = document.querySelector('[data-setting="pistonCapacityMl"]');
    if (supportCapInput) supportCapInput.value = state.settings.pistonCapacityMl;

    state.isPresetModified = true;
    renderPresetSelector();
    savePresetsToStorage();
    saveRecipesToStorage();
    updateMaterialTypeUI();
    updateStatsAndMixDisplay();
  }

  function updateShellThicknessReadouts() {
    const lh = Math.max(0.5, Number(state.settings.layerHeight) || 2.5);
    const flh = Math.max(0.5, Number(state.settings.firstLayerHeight) || lh);
    const parsedTop = parseInt(state.settings.topLayers, 10);
    const topL = Number.isNaN(parsedTop) ? 2 : Math.max(0, parsedTop);
    const parsedBot = parseInt(state.settings.bottomLayers, 10);
    const botL = Number.isNaN(parsedBot) ? 2 : Math.max(0, parsedBot);

    const totalL = state.sliceResult && state.sliceResult.layerCount ? state.sliceResult.layerCount : 0;
    const topThick = topL * lh;
    const botThick = botL === 0 ? 0 : (flh + Math.max(0, botL - 1) * lh);

    const topEl = document.getElementById('readout-top-thickness');
    const botEl = document.getElementById('readout-bottom-thickness');
    if (topEl) {
      if (topL === 0) {
        topEl.textContent = '0.0 mm (Open Top)';
      } else if (totalL > 0) {
        const startL = Math.max(1, totalL - topL + 1);
        topEl.textContent = `${topThick.toFixed(1)} mm (L${startL}–L${totalL})`;
      } else {
        topEl.textContent = `${topThick.toFixed(1)} mm (${topL} layers)`;
      }
    }
    if (botEl) {
      if (botL === 0) {
        botEl.textContent = '0.0 mm (Open Bottom)';
      } else {
        const endL = totalL > 0 ? Math.min(totalL, botL) : botL;
        botEl.textContent = `${botThick.toFixed(1)} mm (L1–L${endL})`;
      }
    }
  }

  function syncSettingsToUI() {
    document.querySelectorAll('.mode-card[data-mode]').forEach(card => {
      card.classList.toggle('active', card.dataset.mode === state.settings.printMode);
    });

    document.querySelectorAll('[data-setting]').forEach(el => {
      const key = el.dataset.setting;
      if (state.settings[key] === undefined) return;
      if (el.type === 'checkbox') {
        el.checked = Boolean(state.settings[key]);
      } else {
        el.value = state.settings[key];
      }
    });

    updateShellThicknessReadouts();
    updateEAxisModeVisibility();
    updateSupportUIState();
    updateMaterialTypeUI();
  }

  function updateEAxisModeVisibility() {
    const mode = state.settings.eAxisMode;
    document.getElementById('row-equiv-filament').style.display = mode === 'filament' ? 'flex' : 'none';
    document.getElementById('row-auger-mm-ml').style.display = mode === 'mm_per_ml' ? 'flex' : 'none';
  }

  // =========================================================================
  // SUPPORT STRATEGY & MANUAL LAYER PAUSE INJECTION
  // =========================================================================

  function updateSupportUIState() {
    const isSupportEnabled = Boolean(state.settings.enableSupport);
    const adaptiveGroup = document.getElementById('group-support-adaptive-settings');
    if (adaptiveGroup) {
      adaptiveGroup.style.opacity = isSupportEnabled ? '1.0' : '0.4';
      adaptiveGroup.style.pointerEvents = isSupportEnabled ? 'auto' : 'none';
    }

    const summaryEl = document.getElementById('support-detection-summary');
    const exportBtn = document.getElementById('btn-export-support-stl');

    if (!isSupportEnabled) {
      if (summaryEl) {
        summaryEl.innerHTML = 'Support is disabled by default. Enable Support above and click <strong>Slice Plate</strong> to analyze overhangs and build adaptive 3D support.';
      }
      if (exportBtn) {
        exportBtn.disabled = true;
        exportBtn.textContent = 'Export Support STL (.stl)';
      }
    } else if (!state.hasSlicedWithSupport || !state.supportResult) {
      if (summaryEl) {
        summaryEl.innerHTML = '<span style="color: #fbbf24; font-weight: 600;">Ready to Generate:</span> Click <strong>Slice Plate</strong> below to detect model overhangs and generate adaptive hollow 3D support.';
      }
      if (exportBtn) {
        exportBtn.disabled = true;
        exportBtn.textContent = 'Slice Plate Required to Export STL';
      }
    } else if (state.supportResult && state.supportResult.hasOverhang && state.supportResult.mesh && state.supportResult.mesh.triangleCount > 0) {
      const sr = state.supportResult;
      const b = sr.mesh.bounds;
      const pauseText = sr.pauseLayers && sr.pauseLayers.length > 0
        ? `Layer ${sr.pauseLayers.join(', ')}`
        : 'None';
      if (summaryEl) {
        summaryEl.innerHTML = `
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
            <span style="color: #34d399; font-weight: 700;">✓ ${sr.regionCount} Adaptive Support${sr.regionCount > 1 ? 's' : ''} Generated</span>
            <span style="font-family: var(--font-mono); font-size: 10px; color: var(--text-muted);">${sr.savedPercent.toFixed(0)}% Hollow Saved</span>
          </div>
          <div style="font-family: var(--font-mono); font-size: 10.5px; color: var(--text-primary); line-height: 1.5;">
            Size: ${b.sizeX.toFixed(1)} × ${b.sizeY.toFixed(1)} × ${b.sizeZ.toFixed(1)} mm<br/>
            Plastic Vol: ~${sr.supportVolumeMl.toFixed(1)} ml (vs ${sr.solidVolumeMl.toFixed(1)} ml solid)<br/>
            Insert Pause: <strong>${pauseText}</strong>
          </div>
        `;
      }
      if (exportBtn) {
        exportBtn.disabled = false;
        exportBtn.textContent = `Export Support STL (${sr.regionCount} part${sr.regionCount > 1 ? 's' : ''})`;
      }
    } else {
      if (summaryEl) {
        summaryEl.innerHTML = `<span style="color: var(--text-primary); font-weight: 600;">No Overhangs Detected (&gt;${state.settings.supportOverhangAngle}°):</span> This model orientation is self-supporting and requires no support insert.`;
      }
      if (exportBtn) {
        exportBtn.disabled = true;
        exportBtn.textContent = 'No Support Needed';
      }
    }

    renderSupportPauseTags();

    // Dynamically update layers in active sliceResult if present
    if (state.sliceResult && state.sliceResult.layers && window.JihuEngine && window.JihuEngine.parsePauseLayers) {
      const pauseSet = window.JihuEngine.parsePauseLayers(state.settings.supportPauseLayers);
      for (const layer of state.sliceResult.layers) {
        const isSupportOrManual = (isSupportEnabled || Boolean(state.settings.supportPauseLayers)) && pauseSet.has(layer.index + 1);
        layer.isPauseLayer = Boolean(isSupportOrManual || layer.isPistonPause);
      }
      updateLayerScrubberReadout(playbackState.activeLayerIdx);
    }
  }

  function exportSupportSTLFile() {
    if (!state.settings.enableSupport || !state.hasSlicedWithSupport || !state.supportResult || !state.supportResult.mesh || state.supportResult.mesh.triangleCount > 0) {
      showCIMAlert({
        title: 'Support STL Not Ready',
        message: 'Please enable Support in the Support tab and click "Slice Plate" first to generate the adaptive 3D support geometry.'
      });
      return;
    }

    const baseName = (state.modelName || 'cim_model').replace(/\.[^/.]+$/, '');
    const headerLabel = `CIM Slicer 0.4.0 Adaptive Support - ${baseName}`;
    const stlBuffer = window.JihuEngine.meshToBinarySTL(state.supportResult.mesh, headerLabel);
    if (!stlBuffer) return;

    const blob = new Blob([stlBuffer], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const fileName = `${baseName}_support.stl`;

    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast(`Support STL downloaded: ${fileName}`);
  }

  function renderSupportPauseTags() {
    const container = document.getElementById('support-pause-tags-container');
    if (!container) return;
    container.innerHTML = '';

    const parseFn = (window.JihuEngine && window.JihuEngine.parsePauseLayers) ? window.JihuEngine.parsePauseLayers : null;
    const isSupportEnabled = Boolean(state.settings.enableSupport);
    const pauseSet = (parseFn && (isSupportEnabled || state.settings.supportPauseLayers)) ? parseFn(state.settings.supportPauseLayers) : new Set();
    const sortedManualLayers = Array.from(pauseSet).sort((a, b) => a - b);

    const pistonPauses = (state.sliceResult && state.sliceResult.pistonPauseLayers) ? state.sliceResult.pistonPauseLayers : [];

    if (sortedManualLayers.length === 0 && pistonPauses.length === 0) {
      container.innerHTML = '<span style="font-size: 11px; color: var(--text-muted); font-style: italic;">No pause layers scheduled. Enter layer numbers above, click "+ Add Current Layer", or auto-trigger via 90% piston limit.</span>';
      return;
    }

    // 1. Render Piston Auto-Pauses first (if any)
    for (const p of pistonPauses) {
      const layerNum = typeof p === 'object' ? p.layerIndex : Number(p);
      const targetL = (state.sliceResult && state.sliceResult.layers && layerNum > 0)
        ? state.sliceResult.layers[layerNum - 1]
        : null;
      const det = (targetL && targetL.pistonDetails) ? targetL.pistonDetails : (typeof p === 'object' ? p : null);
      const vol = det && (det.volBeforeMl != null ? det.volBeforeMl : det.volumeBeforeMl);
      const volNum = typeof vol === 'number' ? vol : null;
      const volStr = volNum !== null ? ` · ${volNum.toFixed(0)}ml` : '';
      const cycle = det && det.cylinderIndex ? det.cylinderIndex : 1;

      const pill = document.createElement('div');
      pill.className = 'support-pause-pill piston-pause-pill';
      pill.title = `Auto-pause before Layer ${layerNum}${volNum !== null ? ` (Extruded: ${volNum.toFixed(0)}ml, reaching 90% limit of 500ml Piston #${cycle})` : ''}. Click to inspect in preview.`;
      pill.innerHTML = `<span>⏸ L${layerNum} (Piston 90%${volStr})</span>`;
      pill.addEventListener('click', () => {
        const slider = document.getElementById('layer-slider');
        if (slider && state.sliceResult && state.sliceResult.layerCount > 0) {
          const targetIdx = Math.max(0, Math.min(state.sliceResult.layerCount - 1, layerNum - 1));
          slider.value = targetIdx;
          slider.dispatchEvent(new Event('input'));
        }
      });
      container.appendChild(pill);
    }

    // 2. Render Support / Manual pause layers
    for (const layerNum of sortedManualLayers) {
      const isAlsoPiston = pistonPauses.some(p => (typeof p === 'object' ? p.layerIndex : Number(p)) === layerNum);
      if (isAlsoPiston) continue;

      const pill = document.createElement('div');
      pill.className = 'support-pause-pill';
      pill.title = `Pause scheduled before Layer ${layerNum}. Click to inspect layer in preview.`;
      pill.innerHTML = `<span>⏸ Layer ${layerNum}</span><button type="button" title="Remove pause before Layer ${layerNum}">✕</button>`;

      const removeBtn = pill.querySelector('button');
      removeBtn.addEventListener('click', e => {
        e.stopPropagation();
        removeSupportPauseLayer(layerNum);
      });

      pill.addEventListener('click', () => {
        const slider = document.getElementById('layer-slider');
        if (slider && state.sliceResult && state.sliceResult.layerCount > 0) {
          const targetIdx = Math.max(0, Math.min(state.sliceResult.layerCount - 1, layerNum - 1));
          slider.value = targetIdx;
          slider.dispatchEvent(new Event('input'));
        }
      });

      container.appendChild(pill);
    }
  }

  function removeSupportPauseLayer(layerNum) {
    const parseFn = (window.JihuEngine && window.JihuEngine.parsePauseLayers) ? window.JihuEngine.parsePauseLayers : null;
    if (!parseFn) return;
    const pauseSet = parseFn(state.settings.supportPauseLayers);
    pauseSet.delete(layerNum);
    const sorted = Array.from(pauseSet).sort((a, b) => a - b);
    const newStr = sorted.join(', ');
    state.settings.supportPauseLayers = newStr;
    const input = document.getElementById('input-support-pause-layers');
    if (input) input.value = newStr;

    state.isPresetModified = true;
    renderPresetSelector();
    savePresetsToStorage();
    updateSupportUIState();
    if (state.hasSliced) {
      runSlicer({ changedKey: 'supportPauseLayers' });
    } else {
      updateStatsAndMixDisplay();
    }
    showToast(`Pause before Layer ${layerNum} removed`);
  }

  function addSupportPauseLayer(layerNum) {
    if (!layerNum || layerNum < 1) return;
    const parseFn = (window.JihuEngine && window.JihuEngine.parsePauseLayers) ? window.JihuEngine.parsePauseLayers : null;
    if (!parseFn) return;
    const pauseSet = parseFn(state.settings.supportPauseLayers);
    pauseSet.add(layerNum);
    const sorted = Array.from(pauseSet).sort((a, b) => a - b);
    const newStr = sorted.join(', ');
    state.settings.supportPauseLayers = newStr;
    const input = document.getElementById('input-support-pause-layers');
    if (input) input.value = newStr;

    state.isPresetModified = true;
    renderPresetSelector();
    savePresetsToStorage();
    updateSupportUIState();
    if (state.hasSliced) {
      runSlicer({ changedKey: 'supportPauseLayers' });
    } else {
      updateStatsAndMixDisplay();
    }
    showToast(`Pause scheduled before Layer ${layerNum}`);
  }

  // =========================================================================
  // MODEL LOADING & SLICING EXECUTION
  // =========================================================================

  function loadBuiltinPrimitive(type, label) {
    state.modelName = label;
    state.rawMesh = window.JihuEngine.createPrimitive(type);
    document.getElementById('active-model-label').textContent = label;
    updateTransformedMesh();
    viewport.resize();
    viewport.resetCamera('iso');
    setWorkspaceView('prepare');
    updateStatsAndMixDisplay();
  }

  function loadUserModelFile(file) {
    const reader = new FileReader();
    const ext = file.name.split('.').pop().toLowerCase();

    reader.onload = async e => {
      try {
        let mesh = null;
        if (ext === 'obj') {
          const text = new TextDecoder().decode(e.target.result);
          mesh = window.JihuEngine.parseOBJ(text);
        } else if (ext === '3mf') {
          mesh = await window.JihuEngine.parse3MF(e.target.result);
        } else {
          mesh = window.JihuEngine.parseSTL(e.target.result);
        }
        if (!mesh || !mesh.vertices || mesh.vertices.length === 0) {
          showCIMAlert({
            title: 'File Parse Error',
            message: 'Could not parse 3D geometry triangles from the selected file.'
          });
          return;
        }
        state.modelName = file.name;
        state.rawMesh = mesh;
        document.getElementById('active-model-label').textContent = file.name;
        document.getElementById('builtin-model-select').value = '';
        updateTransformedMesh();
        viewport.resize();
        viewport.resetCamera('iso');
        setWorkspaceView('prepare');
        updateStatsAndMixDisplay();
      } catch (err) {
        console.error(err);
        showCIMAlert({
          title: 'Load Error',
          message: 'Error loading 3D model file: ' + err.message
        });
      }
    };
    reader.readAsArrayBuffer(file);
  }

  let currentWorkspaceView = 'prepare';

  function updateTransformedMesh() {
    if (!state.rawMesh) return;
    const bed = {
      x: state.settings.bedX,
      y: state.settings.bedY,
      z: state.settings.bedZ
    };
    state.transformedMesh = window.JihuEngine.transformMesh(state.rawMesh, state.transform, bed);
    viewport.setMesh(state.transformedMesh);

    // Clear previously generated slice & support when model or orientation changes until user slices again
    state.hasSliced = false;
    state.sliceResult = null;
    if (viewport && viewport.setSliceResult) {
      viewport.setSliceResult(null);
    }
    state.hasSlicedWithSupport = false;
    state.supportResult = null;
    if (viewport && viewport.setSupportMesh) {
      viewport.setSupportMesh(null);
    }
    updateSupportUIState();
    updateStatsAndMixDisplay();

    const b = state.transformedMesh.bounds;
    const dimLabel = document.getElementById('model-dimensions-label');
    if (dimLabel && b) {
      dimLabel.textContent = `${b.sizeX.toFixed(1)} × ${b.sizeY.toFixed(1)} × ${b.sizeZ.toFixed(1)} mm (${state.transformedMesh.triangleCount.toLocaleString()} tris)`;
    }
  }

  function runSlicer(opts) {
    if (!state.transformedMesh) return;
    const changedKey = opts && opts.changedKey ? opts.changedKey : null;
    const fromExplicitSlice = Boolean(opts && opts.fromExplicitSlice);
    if (fromExplicitSlice) {
      state.hasSliced = true;
    }

    state.sliceResult = window.JihuEngine.sliceModel(state.transformedMesh, state.settings);
    if (!state.sliceResult) {
      updateStatsAndMixDisplay();
      return;
    }

    // Strict Support Workflow Gate:
    // Only detect overhangs & generate 3D support when Enable Support is checked AND user slices via 'Slice Plate'
    if (state.settings.enableSupport && (fromExplicitSlice || state.hasSlicedWithSupport)) {
      state.hasSlicedWithSupport = true;
      if (window.JihuEngine && typeof window.JihuEngine.detectOverhangsAndGenerateSupport === 'function') {
        state.supportResult = window.JihuEngine.detectOverhangsAndGenerateSupport(
          state.transformedMesh,
          state.settings,
          state.sliceResult
        );
      }
      if (viewport && viewport.setSupportMesh) {
        viewport.setSupportMesh(state.supportResult && state.supportResult.mesh ? state.supportResult.mesh : null);
      }

      if (
        state.settings.supportAutoPause &&
        state.supportResult &&
        Array.isArray(state.supportResult.pauseLayers) &&
        (fromExplicitSlice || changedKey === 'supportOverhangAngle' || changedKey === 'supportAutoPause' || changedKey === 'layerHeight' || changedKey === 'firstLayerHeight')
      ) {
        const autoStr = state.supportResult.pauseLayers.join(', ');
        state.settings.supportPauseLayers = autoStr;
        const pauseInput = document.getElementById('input-support-pause-layers');
        if (pauseInput) pauseInput.value = autoStr;
      }

      updateSupportUIState();

      if (fromExplicitSlice) {
        if (state.supportResult && state.supportResult.hasOverhang) {
          showToast(`Overhang detected: ${state.supportResult.regionCount} adaptive support(s) generated (Ready for STL export)`);
        } else {
          showToast('No overhangs detected: Current model orientation is self-supporting.');
        }
      }
    } else {
      if (!state.settings.enableSupport) {
        state.hasSlicedWithSupport = false;
      }
      state.supportResult = null;
      if (viewport && viewport.setSupportMesh) {
        viewport.setSupportMesh(null);
      }
      updateSupportUIState();
    }

    if (fromExplicitSlice && state.sliceResult && state.sliceResult.pistonPauseLayers && state.sliceResult.pistonPauseLayers.length > 0) {
      const pLayers = state.sliceResult.pistonPauseLayers.map(p => `Layer ${typeof p === 'object' ? p.layerIndex : p}`).join(', ');
      const capMl = Math.max(50, Number(state.settings.pistonCapacityMl) || 500);
      showToast(`Print exceeds ${capMl}ml piston: Auto-pause scheduled at 90% before ${pLayers} for reload.`);
    }

    viewport.setSliceResult(state.sliceResult);
    updateShellThicknessReadouts();

    const widthInd = document.getElementById('preview-width-indicator');
    if (widthInd) {
      widthInd.textContent = `Line Width: ${Number(state.settings.lineWidth).toFixed(1)}mm`;
    }

    const layerSlider = document.getElementById('layer-slider');
    const singleLayerCheck = document.getElementById('chk-single-layer');
    const maxIdx = Math.max(0, state.sliceResult.layerCount - 1);
    layerSlider.max = maxIdx;

    // Choose smart preview layer so user immediately sees the effect of Top/Bottom/Infill changes
    let targetLayer = maxIdx;
    const parsedBot = parseInt(state.settings.bottomLayers, 10);
    const botL = Number.isNaN(parsedBot) ? 2 : Math.max(0, parsedBot);
    const parsedTop = parseInt(state.settings.topLayers, 10);
    const topL = Number.isNaN(parsedTop) ? 2 : Math.max(0, parsedTop);

    if (changedKey === 'bottomLayers' || changedKey === 'bottomSurfacePattern') {
      // Show top of bottom shell (or layer 0 if bottomLayers == 0) so bottom shell isn't hidden under upper layers
      targetLayer = botL > 0 ? Math.min(maxIdx, botL - 1) : 0;
    } else if (changedKey === 'internalSolidInfillPattern') {
      targetLayer = topL > 1 ? Math.max(0, maxIdx - 1) : (botL > 1 ? 1 : maxIdx);
    } else if (changedKey === 'infillDensity' || changedKey === 'infillPattern') {
      // If top shell covers the model, cut to mid-height so user sees the sparse infill change
      targetLayer = topL > 0 ? Math.floor(maxIdx * 0.5) : maxIdx;
    } else {
      targetLayer = maxIdx;
    }

    layerSlider.value = targetLayer;
    viewport.setLayerFilter(targetLayer, singleLayerCheck ? singleLayerCheck.checked : false);
    updateLayerScrubberReadout(targetLayer);

    playbackState.activeLayerIdx = targetLayer;
    const targetL = state.sliceResult.layers[targetLayer];
    playbackState.activeMoveIdx = targetL && targetL.moves ? Math.max(0, targetL.moves.length - 1) : 0;
    playbackState.activeFraction = 1.0;
    updateMoveScrubberAndHUD(targetLayer, playbackState.activeMoveIdx, 1.0);

    if (opts && opts.switchView) {
      setWorkspaceView('preview');
    } else {
      setWorkspaceView(currentWorkspaceView);
    }
    updateStatsAndMixDisplay();
  }

  function setWorkspaceView(mode) {
    currentWorkspaceView = mode;
    document.querySelectorAll('.workspace-tab').forEach(b => {
      b.classList.toggle('active', b.dataset.view === mode);
    });
    viewport.setViewMode(mode);
    if (mode !== 'preview') {
      pausePlayback();
      viewport.setNozzlePlayback({ active: false });
    } else {
      viewport.setNozzlePlayback({
        active: true,
        layerIdx: playbackState.activeLayerIdx,
        moveIdx: playbackState.activeMoveIdx,
        fraction: playbackState.activeFraction,
        nozzleDiameter: Number(state.settings.lineWidth) || 5.0
      });
    }
    document.getElementById('layer-scrubber-bar').style.display = mode === 'preview' ? 'flex' : 'none';
    const previewMenu = document.getElementById('preview-display-menu');
    const preparePanel = document.getElementById('prepare-transform-panel');
    if (previewMenu) previewMenu.style.display = mode === 'preview' ? 'flex' : 'none';
    if (preparePanel) preparePanel.style.display = mode === 'prepare' ? 'flex' : 'none';
  }

  function updateLayerScrubberReadout(layerIdx) {
    const readout = document.getElementById('layer-readout');
    if (!state.sliceResult || state.sliceResult.layerCount === 0) {
      readout.textContent = 'Layer 0 / 0 (0.0 mm)';
      return;
    }
    const clamped = Math.min(state.sliceResult.layerCount - 1, Math.max(0, layerIdx));
    const layer = state.sliceResult.layers[clamped];
    const zVal = layer ? layer.z.toFixed(2) : '0.00';
    let roleTag = '';
    if (layer && layer.shellRole) {
      if (layer.shellRole === 'top_shell') roleTag = ' · Top Shell';
      else if (layer.shellRole === 'bottom_shell') roleTag = ' · Bottom Shell';
      else if (layer.shellRole === 'spiral') roleTag = ' · Spiral Vase Wall';
      else if (state.settings.printMode === 'single_wall') roleTag = ' · Single Wall';
      else roleTag = ' · Sparse Infill';
    }
    let pauseBadge = '';
    if (layer && layer.isPauseLayer) {
      if (layer.isPistonPause) {
        const det = layer.pistonDetails;
        const vol = det && (det.volBeforeMl != null ? det.volBeforeMl : det.volumeBeforeMl);
        const volText = typeof vol === 'number' ? ` · ${vol.toFixed(0)}ml` : '';
        pauseBadge = ` <span style="background: rgba(245, 158, 11, 0.22); color: #fbbf24; border: 1px solid rgba(245, 158, 11, 0.55); padding: 1px 6px; border-radius: 4px; font-weight: 700; margin-left: 6px; font-size: 11px;">⏸ 90% PISTON REFILL${volText}</span>`;
      } else {
        pauseBadge = ' <span style="background: rgba(245, 158, 11, 0.22); color: #fbbf24; border: 1px solid rgba(245, 158, 11, 0.55); padding: 1px 6px; border-radius: 4px; font-weight: 700; margin-left: 6px; font-size: 11px;">⏸ PAUSE BEFORE LAYER</span>';
      }
    }
    readout.innerHTML = `Layer ${clamped + 1} / ${state.sliceResult.layerCount} (Z = ${zVal} mm)${roleTag}${pauseBadge}`;
  }

  // =========================================================================
  // NOZZLE MOTION & TOOLPATH PLAYBACK CONTROLLER
  // =========================================================================

  const playbackState = {
    isPlaying: false,
    speedMultiplier: 1.0,
    autoAdvanceLayer: true,
    activeLayerIdx: 0,
    activeMoveIdx: 0,
    activeFraction: 1.0,
    lastFrameTime: 0,
    rafId: null
  };

  function updateMoveScrubberAndHUD(layerIdx, moveIdx, fraction) {
    const moveSlider = document.getElementById('move-slider');
    const hudMoveStep = document.getElementById('hud-move-step');
    const hudMoveType = document.getElementById('hud-move-type');
    const hudMoveSpeed = document.getElementById('hud-move-speed');
    const hudMovePos = document.getElementById('hud-move-pos');

    if (!state.sliceResult || !state.sliceResult.layers || state.sliceResult.layers.length === 0) {
      if (hudMoveStep) hudMoveStep.textContent = 'Move 0 / 0';
      if (hudMoveType) { hudMoveType.textContent = 'Standby'; hudMoveType.className = 'move-badge-type'; }
      if (hudMoveSpeed) hudMoveSpeed.textContent = '0 mm/s';
      if (hudMovePos) hudMovePos.textContent = 'X: 0.0 Y: 0.0 Z: 0.0';
      if (moveSlider) moveSlider.value = 1000;
      return;
    }

    const clampedL = Math.max(0, Math.min(state.sliceResult.layers.length - 1, layerIdx));
    const layer = state.sliceResult.layers[clampedL];
    if (!layer || !layer.moves || layer.moves.length === 0) {
      if (hudMoveStep) hudMoveStep.textContent = 'Move 0 / 0';
      if (hudMoveType) { hudMoveType.textContent = 'Empty Layer'; hudMoveType.className = 'move-badge-type'; }
      if (hudMoveSpeed) hudMoveSpeed.textContent = '0 mm/s';
      if (hudMovePos) hudMovePos.textContent = `X: 0.0 Y: 0.0 Z: ${layer ? layer.z.toFixed(2) : '0.0'}`;
      if (moveSlider) moveSlider.value = 1000;
      return;
    }

    const totalMoves = layer.moves.length;
    const clampedM = Math.max(0, Math.min(totalMoves - 1, moveIdx));
    const frac = Math.max(0, Math.min(1.0, fraction));
    const mv = layer.moves[clampedM];

    if (moveSlider) {
      const prog = Math.min(1000, Math.round(((clampedM + frac) / totalMoves) * 1000));
      moveSlider.value = prog;
    }

    if (hudMoveStep) {
      const pct = Math.round(((clampedM + frac) / totalMoves) * 100);
      hudMoveStep.textContent = `Move ${clampedM + 1} / ${totalMoves} (${pct}%)`;
    }

    if (hudMoveType) {
      let typeLabel = 'Travel';
      if (mv.type === 'outer_wall') typeLabel = 'Outer Wall';
      else if (mv.type === 'inner_wall') typeLabel = 'Inner Wall';
      else if (mv.type === 'solid_infill') typeLabel = 'Solid Shell';
      else if (mv.type === 'sparse_infill') typeLabel = 'Sparse Infill';
      else if (mv.type === 'spiral_wall') typeLabel = 'Spiral Wall';
      hudMoveType.textContent = typeLabel;
      hudMoveType.className = `move-badge-type ${mv.type}`;
    }

    if (hudMoveSpeed) {
      hudMoveSpeed.textContent = `${mv.speed ? mv.speed.toFixed(0) : 25} mm/s`;
    }

    const curX = mv.x1 + (mv.x2 - mv.x1) * frac;
    const curY = mv.y1 + (mv.y2 - mv.y1) * frac;
    const curZ = mv.z1 + (mv.z2 - mv.z1) * frac;

    if (hudMovePos) {
      hudMovePos.textContent = `X: ${curX.toFixed(1)}  Y: ${curY.toFixed(1)}  Z: ${curZ.toFixed(1)}`;
    }

    viewport.setNozzlePlayback({
      active: true,
      layerIdx: clampedL,
      moveIdx: clampedM,
      fraction: frac,
      nozzleDiameter: Number(state.settings.lineWidth) || 5.0
    });
  }

  function startPlayback() {
    if (!state.sliceResult || !state.sliceResult.layers || state.sliceResult.layers.length === 0) return;
    const layer = state.sliceResult.layers[playbackState.activeLayerIdx];
    const totalMoves = layer && layer.moves ? layer.moves.length : 0;
    if (totalMoves === 0) return;

    if (playbackState.activeMoveIdx >= totalMoves - 1 && playbackState.activeFraction >= 0.999) {
      playbackState.activeMoveIdx = 0;
      playbackState.activeFraction = 0.0;
    }

    playbackState.isPlaying = true;
    playbackState.lastFrameTime = performance.now();

    const btnPlay = document.getElementById('btn-play-toggle');
    const playIcon = document.getElementById('play-btn-icon');
    const playText = document.getElementById('play-btn-text');
    if (btnPlay) btnPlay.classList.add('playing');
    if (playIcon) playIcon.textContent = '❚❚';
    if (playText) playText.textContent = 'Pause';

    if (playbackState.rafId) cancelAnimationFrame(playbackState.rafId);
    playbackState.rafId = requestAnimationFrame(playbackTick);
  }

  function pausePlayback() {
    playbackState.isPlaying = false;
    if (playbackState.rafId) {
      cancelAnimationFrame(playbackState.rafId);
      playbackState.rafId = null;
    }

    const btnPlay = document.getElementById('btn-play-toggle');
    const playIcon = document.getElementById('play-btn-icon');
    const playText = document.getElementById('play-btn-text');
    if (btnPlay) btnPlay.classList.remove('playing');
    if (playIcon) playIcon.textContent = '▶';
    if (playText) playText.textContent = 'Play';
  }

  function togglePlayback() {
    if (playbackState.isPlaying) {
      pausePlayback();
    } else {
      startPlayback();
    }
  }

  function stepPlayback(deltaMoves) {
    pausePlayback();
    if (!state.sliceResult || !state.sliceResult.layers) return;
    const layer = state.sliceResult.layers[playbackState.activeLayerIdx];
    if (!layer || !layer.moves || layer.moves.length === 0) return;
    const totalMoves = layer.moves.length;
    playbackState.activeMoveIdx = Math.max(0, Math.min(totalMoves - 1, playbackState.activeMoveIdx + deltaMoves));
    playbackState.activeFraction = 0.0;
    updateMoveScrubberAndHUD(playbackState.activeLayerIdx, playbackState.activeMoveIdx, 0.0);
  }

  function playbackTick(now) {
    if (!playbackState.isPlaying) return;
    const dt = Math.min(0.1, (now - playbackState.lastFrameTime) / 1000);
    playbackState.lastFrameTime = now;

    if (!state.sliceResult || !state.sliceResult.layers) {
      pausePlayback();
      return;
    }

    const layer = state.sliceResult.layers[playbackState.activeLayerIdx];
    const totalMoves = layer && layer.moves ? layer.moves.length : 0;
    if (totalMoves === 0) {
      pausePlayback();
      return;
    }

    const mv = layer.moves[playbackState.activeMoveIdx];
    const segLen = Math.hypot(mv.x2 - mv.x1, mv.y2 - mv.y1, mv.z2 - mv.z1);
    const speed = Math.max(5, (mv.speed || 25) * playbackState.speedMultiplier);
    const segTime = Math.max(0.015, segLen / speed);
    const dFrac = dt / segTime;

    playbackState.activeFraction += dFrac;

    const layerSlider = document.getElementById('layer-slider');
    const singleLayerCheck = document.getElementById('chk-single-layer');

    while (playbackState.activeFraction >= 1.0) {
      playbackState.activeFraction -= 1.0;
      playbackState.activeMoveIdx++;
      if (playbackState.activeMoveIdx >= totalMoves) {
        if (playbackState.autoAdvanceLayer && playbackState.activeLayerIdx < state.sliceResult.layerCount - 1) {
          playbackState.activeLayerIdx++;
          if (layerSlider) layerSlider.value = playbackState.activeLayerIdx;
          updateLayerScrubberReadout(playbackState.activeLayerIdx);
          viewport.setLayerFilter(playbackState.activeLayerIdx, singleLayerCheck ? singleLayerCheck.checked : false);
          playbackState.activeMoveIdx = 0;
          playbackState.activeFraction = 0.0;
          break;
        } else {
          playbackState.activeMoveIdx = totalMoves - 1;
          playbackState.activeFraction = 1.0;
          pausePlayback();
          break;
        }
      }
    }

    updateMoveScrubberAndHUD(playbackState.activeLayerIdx, playbackState.activeMoveIdx, playbackState.activeFraction);

    if (playbackState.isPlaying) {
      playbackState.rafId = requestAnimationFrame(playbackTick);
    }
  }

  // =========================================================================
  // MIX RECIPE EDITOR & REAL-TIME MATERIAL WEIGHT/VOLUME RECALCULATION
  // =========================================================================

  function renderRecipeSelector() {
    const sel = document.getElementById('recipe-select');
    sel.innerHTML = '';
    for (const r of state.recipes) {
      const opt = document.createElement('option');
      opt.value = r.id;
      opt.textContent = r.name;
      if (r.id === state.activeRecipeId) opt.selected = true;
      sel.appendChild(opt);
    }
  }

  function renderRecipeEditor() {
    if (!state.currentRecipe) return;
    document.getElementById('recipe-name-input').value = state.currentRecipe.name || '';
    const effCylVol = state.settings.materialType === 'ceramic'
      ? (Number(state.settings.pistonCapacityMl) || Number(state.currentRecipe.cylinderVolumeMl) || 500)
      : (Number(state.currentRecipe.cylinderVolumeMl) || Number(state.settings.pistonCapacityMl) || 500);
    document.getElementById('recipe-cylinder-vol').value = effCylVol;

    const listEl = document.getElementById('ingredient-list');
    listEl.innerHTML = '';

    state.currentRecipe.ingredients.forEach((ing, idx) => {
      const row = document.createElement('div');
      row.className = 'ingredient-row';

      const nameInput = document.createElement('input');
      nameInput.type = 'text';
      nameInput.value = ing.name;
      nameInput.placeholder = 'Component name';
      nameInput.addEventListener('input', () => {
        state.currentRecipe.ingredients[idx].name = nameInput.value;
        renderIngredientPercentages();
        updateStatsAndMixDisplay();
      });

      const weightInput = document.createElement('input');
      weightInput.type = 'number';
      weightInput.step = '0.05';
      weightInput.min = '0';
      weightInput.value = ing.weightGrams;
      weightInput.addEventListener('input', () => {
        state.currentRecipe.ingredients[idx].weightGrams = Math.max(0, parseFloat(weightInput.value) || 0);
        renderIngredientPercentages();
        updateStatsAndMixDisplay();
      });

      const pctSpan = document.createElement('span');
      pctSpan.className = 'ingredient-pct';
      pctSpan.dataset.pctIdx = idx;

      const delBtn = document.createElement('button');
      delBtn.className = 'btn-icon';
      delBtn.title = 'Remove component';
      delBtn.textContent = '×';
      delBtn.addEventListener('click', () => {
        if (state.currentRecipe.ingredients.length <= 1) return;
        state.currentRecipe.ingredients.splice(idx, 1);
        renderRecipeEditor();
        updateStatsAndMixDisplay();
      });

      row.appendChild(nameInput);
      row.appendChild(weightInput);
      row.appendChild(pctSpan);
      row.appendChild(delBtn);
      listEl.appendChild(row);
    });

    const fitBtn = document.getElementById('btn-fit-cylinder-vol');
    if (fitBtn) {
      fitBtn.textContent = `Fit ${state.currentRecipe.cylinderVolumeMl || 500}ml`;
    }

    renderIngredientPercentages();
  }

  function renderIngredientPercentages() {
    if (!state.currentRecipe) return;
    const inferRho = (window.JihuEngine && window.JihuEngine.inferIngredientDensityGPerMl)
      ? window.JihuEngine.inferIngredientDensityGPerMl
      : ((_, d) => Number(d) || 2.0);

    let totalW = 0;
    let totalV = 0;
    const vols = [];

    for (const ing of state.currentRecipe.ingredients) {
      const w = Math.max(0, Number(ing.weightGrams) || 0);
      const rho = inferRho(ing.name, ing.densityGPerMl);
      const v = rho > 0 ? w / rho : 0;
      totalW += w;
      totalV += v;
      vols.push({ w, v, rho });
    }

    state.currentRecipe.ingredients.forEach((ing, idx) => {
      const span = document.querySelector(`[data-pct-idx="${idx}"]`);
      if (span && vols[idx]) {
        const { w, v, rho } = vols[idx];
        const wtPct = totalW > 0 ? (w / totalW) * 100 : 0;
        const volPct = totalV > 0 ? (v / totalV) * 100 : 0;
        span.textContent = v < 10 ? `${v.toFixed(2)}ml` : `${v.toFixed(1)}ml`;
        span.title = `Volume: ${v.toFixed(2)} ml (${volPct.toFixed(1)}% vol) | Weight Share: ${wtPct.toFixed(1)}% | Specific Gravity: ${rho.toFixed(3)} g/ml`;
      }
    });
  }

  function saveCurrentRecipe(saveAsNew) {
    if (!state.currentRecipe) return;
    const cleanName = (state.currentRecipe.name || 'Custom Mix Recipe').trim();
    state.currentRecipe.name = cleanName;

    if (saveAsNew) {
      const newId = 'recipe_' + Date.now();
      const copy = JSON.parse(JSON.stringify(state.currentRecipe));
      copy.id = newId;
      copy.name = cleanName + ' (Copy)';
      state.recipes.push(copy);
      state.activeRecipeId = newId;
      state.currentRecipe = JSON.parse(JSON.stringify(copy));
    } else {
      const idx = state.recipes.findIndex(r => r.id === state.activeRecipeId);
      if (idx !== -1) {
        state.recipes[idx] = JSON.parse(JSON.stringify(state.currentRecipe));
      } else {
        state.recipes.push(JSON.parse(JSON.stringify(state.currentRecipe)));
      }
    }

    saveRecipesToStorage();
    renderRecipeSelector();
    renderRecipeEditor();
    updateStatsAndMixDisplay();

    // Brief visual confirmation on Save button
    const btn = document.getElementById(saveAsNew ? 'btn-save-new-recipe' : 'btn-save-recipe');
    const origText = btn.textContent;
    btn.textContent = 'Saved ✓';
    setTimeout(() => { btn.textContent = origText; }, 1100);
  }

  function updateStatsAndMixDisplay() {
    const mix = window.JihuEngine.calculateMixMetrics(
      state.sliceResult,
      state.currentRecipe,
      state.settings
    );

    // 1. Update Mix Recipe Sidebar Summary Cards (Absolute Volume Method)
    const batchVolMl = typeof mix.computedBatchVolumeMl === 'number' ? mix.computedBatchVolumeMl : mix.refVolumeMl;
    const tubeWeightG = typeof mix.tubeDeadWeightGrams === 'number' ? mix.tubeDeadWeightGrams : (mix.tubeDeadVolumeMl * mix.densityGPerMl);
    document.getElementById('mix-batch-weight').textContent = `${mix.batchTotalWeightG.toFixed(2)} g / ${batchVolMl.toFixed(1)} ml`;
    document.getElementById('mix-wet-density').textContent = `${mix.densityGPerMl.toFixed(3)} g/ml`;
    document.getElementById('mix-wc-ratio').textContent = mix.wcRatio > 0
      ? `${mix.wcRatio.toFixed(3)} · ${mix.openTimeLabel || '90–120m'}`
      : 'N/A';
    document.getElementById('mix-tube-holdup').textContent = `${mix.tubeDeadVolumeMl.toFixed(1)} ml (${tubeWeightG.toFixed(1)} g)`;

    // 2. Update Right Viewport Post-Slice Summary Overlay (hidden until explicitly sliced)
    const isCeramic = state.settings.materialType === 'ceramic';
    const modeLabels = {
      standard: 'STANDARD',
      single_wall: 'SINGLE WALL',
      spiral_vase: 'SPIRAL VASE'
    };
    const matPrefix = isCeramic ? 'CERAMIC · ' : '';
    document.getElementById('stat-badge-mode').textContent =
      `${matPrefix}${modeLabels[state.settings.printMode] || 'STANDARD'} · ${Number(state.settings.lineWidth || 5).toFixed(1)}mm`;

    const statsOverlay = document.getElementById('stats-overlay');
    if (!state.hasSliced || !state.sliceResult) {
      if (statsOverlay) statsOverlay.style.display = 'none';
      return;
    }
    if (statsOverlay) statsOverlay.style.display = '';

    const weightCard = document.getElementById('stat-card-weight');
    const pistonCard = document.getElementById('stat-card-piston');
    const mixBreakdownSection = document.getElementById('stats-mix-breakdown-section');
    if (weightCard) weightCard.style.display = isCeramic ? 'none' : '';
    if (mixBreakdownSection) mixBreakdownSection.style.display = isCeramic ? 'none' : '';
    if (pistonCard) pistonCard.style.gridColumn = isCeramic ? '1 / -1' : '';

    const pistonGaugeLabel = document.getElementById('piston-gauge-label');
    if (pistonGaugeLabel) {
      pistonGaugeLabel.textContent = `${mix.refVolumeMl} ml Piston Cylinder Utilization`;
    }

    document.getElementById('stat-print-time').textContent =
      window.JihuEngine.formatDuration(state.sliceResult.totalPrintTimeSec);
    const pBot = parseInt(state.settings.bottomLayers, 10);
    const bL = Number.isNaN(pBot) ? 2 : Math.max(0, pBot);
    const pTop = parseInt(state.settings.topLayers, 10);
    const tL = Number.isNaN(pTop) ? 2 : Math.max(0, pTop);
    document.getElementById('stat-layer-count').textContent =
      `${state.sliceResult.layerCount}L (${state.settings.layerHeight}mm · Bot:${bL} Top:${tL})`;

    const includeTube = !isCeramic && Boolean(state.settings.includeTubeInMixCalc);
    document.getElementById('stat-volume-ml').textContent =
      `${mix.effectiveVolumeMl.toFixed(1)} ml`;
    document.getElementById('stat-volume-sub').textContent =
      includeTube
        ? `Print: ${mix.printVolumeMl.toFixed(1)} ml + Tube: ${mix.tubeDeadVolumeMl.toFixed(1)} ml`
        : `${(state.sliceResult.totalExtrudedLengthMm / 1000).toFixed(2)} m extruded bead`;

    if (!isCeramic) {
      const weightStr = mix.effectiveWeightGrams >= 1000
        ? `${(mix.effectiveWeightGrams / 1000).toFixed(3)} kg`
        : `${mix.effectiveWeightGrams.toFixed(1)} g`;
      document.getElementById('stat-weight-g').textContent = weightStr;
      document.getElementById('stat-weight-sub').textContent =
        `${mix.effectiveWeightGrams.toFixed(1)} g @ ${mix.densityGPerMl.toFixed(3)} g/ml`;
    }

    const cylinders = includeTube
      ? mix.pistonCylindersWithTube
      : mix.pistonCylindersNeeded;
    const cylPct = cylinders * 100;

    document.getElementById('stat-piston-fills').textContent =
      `${cylinders.toFixed(2)} × ${mix.refVolumeMl}ml`;

    if (state.sliceResult && state.sliceResult.pistonPauseLayers && state.sliceResult.pistonPauseLayers.length > 0) {
      const pCount = state.sliceResult.pistonPauseLayers.length;
      document.getElementById('stat-piston-sub').textContent =
        `Auto-pause scheduled at 90% (${pCount} refill pause${pCount > 1 ? 's' : ''})`;
    } else {
      document.getElementById('stat-piston-sub').textContent =
        cylinders <= 1.0
          ? `${cylPct.toFixed(1)}% of single ${mix.refVolumeMl}ml piston charge`
          : `Requires ${Math.ceil(cylinders)} piston charges (${cylPct.toFixed(0)}%)`;
    }

    const barEl = document.getElementById('piston-bar-fill');
    if (barEl) {
      barEl.style.width = `${Math.min(100, cylPct)}%`;
      if (cylPct >= 90) {
        barEl.style.background = '#f59e0b';
      } else {
        barEl.style.background = 'var(--text-primary)';
      }
    }

    // 3. Render Exact Ingredient Weight & Volume Breakdown Table for the Sliced Model (Concrete only)
    const tbody = document.getElementById('breakdown-tbody');
    tbody.innerHTML = '';
    if (isCeramic) {
      return;
    }

    for (const item of mix.ingredientBreakdown) {
      const tr = document.createElement('tr');
      const neededG = state.settings.includeTubeInMixCalc
        ? item.forPrintPlusTubeGrams
        : item.forPrintGrams;
      const neededVolMl = state.settings.includeTubeInMixCalc
        ? (item.forPrintPlusTubeVolumeMl || 0)
        : (item.forPrintVolumeMl || 0);
      const refVolMl = item.perCylinderVolumeMl || item.perBatchVolumeMl || 0;

      const formattedNeed = neededG < 10 ? neededG.toFixed(2) : neededG.toFixed(1);
      const formattedRef = item.perCylinderGrams < 10
        ? item.perCylinderGrams.toFixed(2)
        : item.perCylinderGrams.toFixed(1);
      const formattedNeedVol = neededVolMl < 10 ? neededVolMl.toFixed(2) : neededVolMl.toFixed(1);
      const formattedRefVol = refVolMl < 10 ? refVolMl.toFixed(2) : refVolMl.toFixed(1);

      tr.title = `Specific Gravity: ${(item.densityGPerMl || 2.0).toFixed(3)} g/ml | Cylinder: ${formattedRef}g (${formattedRefVol}ml) | Print: ${formattedNeed}g (${formattedNeedVol}ml)`;
      tr.innerHTML = `
        <td>${escapeHtml(item.name)}</td>
        <td class="num">${formattedRef} g <span style="color: var(--text-muted); font-size: 9.5px;">(${formattedRefVol}ml)</span></td>
        <td class="num" style="color: var(--text-primary); font-weight: 600;">${formattedNeed} g <span style="color: var(--text-muted); font-size: 9.5px; font-weight: 400;">(${formattedNeedVol}ml)</span></td>
      `;
      tbody.appendChild(tr);
    }

    const totalTr = document.createElement('tr');
    totalTr.className = 'total-row';
    const cylWeight = typeof mix.cylinderNormalizedWeightG === 'number' ? mix.cylinderNormalizedWeightG : mix.batchTotalWeightG;
    totalTr.innerHTML = `
      <td>Total (${escapeHtml(mix.recipeName)})</td>
      <td class="num">${cylWeight.toFixed(1)} g <span style="color: var(--text-muted); font-size: 9.5px;">(${mix.refVolumeMl.toFixed(0)}ml)</span></td>
      <td class="num">${mix.effectiveWeightGrams.toFixed(1)} g <span style="color: var(--text-muted); font-size: 9.5px;">(${mix.effectiveVolumeMl.toFixed(1)}ml)</span></td>
    `;
    tbody.appendChild(totalTr);
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  // =========================================================================
  // G-CODE PREVIEW & EXPORT
  // =========================================================================

  function openGCodeModal() {
    if (!state.sliceResult) {
      if (state.transformedMesh) {
        runSlicer({ fromExplicitSlice: true });
      } else {
        showCIMAlert({
          title: 'Slice Required',
          message: 'Please load a 3D model and slice the plate before previewing G-Code.'
        });
        return;
      }
    }
    const mix = window.JihuEngine.calculateMixMetrics(
      state.sliceResult,
      state.currentRecipe,
      state.settings
    );
    const gcode = window.JihuEngine.generateGCode(state.sliceResult, state.settings, mix);
    const previewLimit = gcode.length > 180000
      ? gcode.slice(0, 180000) + '\n\n; ... [Preview truncated in dialog — click Export G-Code for full file] ...'
      : gcode;
    document.getElementById('gcode-preview-textarea').value = previewLimit;
    document.getElementById('gcode-modal').classList.add('active');
  }

  function exportGCodeFile() {
    if (!state.sliceResult) {
      if (state.transformedMesh) {
        runSlicer({ fromExplicitSlice: true });
      } else {
        showCIMAlert({
          title: 'Slice Required',
          message: 'Please load a 3D model and slice the plate before exporting G-Code.'
        });
        return;
      }
    }
    const mix = window.JihuEngine.calculateMixMetrics(
      state.sliceResult,
      state.currentRecipe,
      state.settings
    );
    const gcode = window.JihuEngine.generateGCode(state.sliceResult, state.settings, mix);
    const blob = new Blob([gcode], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);

    const baseName = (state.modelName || 'cim_model').replace(/\.[^/.]+$/, '');
    const fileName = `${baseName}_${Number(state.settings.lineWidth || 5)}mm_${state.settings.printMode}.gcode`;

    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }
})();
